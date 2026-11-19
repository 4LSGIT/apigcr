// tests/clientUploadBatchService.mysql.test.js
//
/**
 * REAL-ENGINE run of services/clientUploadBatchService (docs intake S3 —
 * per-file reporting + lost-batch recovery): the landed upsert (open / append /
 * cap / refuse), closeByClient's merge and create-on-close, finishByClient's
 * three outcomes, the sweep's due rule, claims and retry branch, and the
 * exactly-once guarantee under real row locks (two sweeps; sweep vs the page's
 * close). Everything that matters here is SQL — the ODKU accept/refuse signal,
 * FOR UPDATE SKIP LOCKED, the UTC clocks — so it runs on MySQL, not a stub.
 *
 * Stubbed: the completion phase (jest.spyOn on
 * clientUploadCompletionService.completeClientUpload — the batch service's
 * job is WHEN and WITH WHAT it is called, and how often; the phase has its own
 * suite, tests/clientUploadCompletion.test.js).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * Its OWN throwaway *_test database (it DELETEs from client_upload_batches,
 * cases, contacts — never share one with another twin family):
 *   mysql -uroot -e 'CREATE DATABASE yc_cub_test'
 *   mysql -uroot yc_cub_test < ref/database.sql
 *   mysql -uroot yc_cub_test < ref/migrations/2026-11-19_client_upload_batches.sql
 *   YC_TEST_MYSQL_URL=mysql://user:pw@127.0.0.1:3306/yc_cub_test \
 *     npx jest tests/clientUploadBatchService.mysql.test.js
 * The session time zone is deliberately NOT UTC (+05:00): every clock in the
 * service must be UTC_TIMESTAMP(), and a NOW() would show up here as a
 * five-hour skew. Run 2026-11-19: MySQL 8.0.46, production sql_mode (prod is
 * Cloud SQL 8.4 — same ODKU row-alias and SKIP LOCKED semantics).
 */

'use strict';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

maybe('client upload batches on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const completion = require('../services/clientUploadCompletionService');
  const svc = require('../services/clientUploadBatchService');
  let pool;
  let spy;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 8,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}', time_zone = '+05:00'`));
    const [[t]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'client_upload_batches'");
    if (!Number(t.n)) throw new Error('apply ref/migrations/2026-11-19_client_upload_batches.sql to the test database first');
  });
  afterAll(async () => { if (pool) await pool.end(); });

  beforeEach(async () => {
    await q('DELETE FROM client_upload_batches');
    await q("DELETE FROM cases WHERE case_id LIKE 'CUB%'");
    await q("DELETE FROM contacts WHERE contact_lname = 'Batchtest'");
    for (const id of ['CUBCASE1', 'CUBCASE2']) {
      await q(`INSERT INTO cases (case_id, case_stage, case_type, case_open_date) VALUES (?, 'Open', 'Bankruptcy', '2026-10-01')`, [id]);
    }
    spy = jest.spyOn(completion, 'completeClientUpload').mockImplementation(async () => ({ sent: true }));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  // ── fixtures ──────────────────────────────────────────────────────────────
  let keySeq = 0;
  const key = () => `k${String(++keySeq).padStart(4, '0')}${Math.random().toString(36).slice(2, 14)}`.padEnd(20, 'x');
  async function contact(fname) {
    const r = await q(
      `INSERT INTO contacts (contact_type, contact_fname, contact_lname, contact_name, contact_lfm_name, contact_rname, contact_mname)
       VALUES ('Client', ?, 'Batchtest', '', '', '', '')`, [fname]);
    return r.insertId;
  }
  const row = async (k) => {
    const [r] = await q('SELECT * FROM client_upload_batches WHERE batch_key = ?', [k]);
    if (r) r.filesParsed = JSON.parse(r.files);
    return r;
  };
  const docreq = (k, name, over = {}) => svc.landed(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE1', file: { name }, ...over });
  /** Move a row's clocks into the past (minutes) — the quiet / stale rules are SQL's. */
  const age = (k, col, min) => q(`UPDATE client_upload_batches SET ${col} = UTC_TIMESTAMP() - INTERVAL ? MINUTE WHERE batch_key = ?`, [min, k]);

  // ── landed ────────────────────────────────────────────────────────────────
  describe('landed', () => {
    test('the first file opens the row, later files append; UTC clocks; the last non-blank comment wins', async () => {
      const k = key();
      const a = await docreq(k, 'W2.pdf', { comment: 'taxes' });
      expect(a).toEqual({ accepted: true, id: expect.any(Number), opened: true });
      const b = await docreq(k, 'Lease.pdf', { comment: '' });
      expect(b).toEqual({ accepted: true, id: a.id, opened: false });
      await docreq(k, 'Stub.pdf', { comment: 'and a pay stub' });

      const r = await row(k);
      expect(r).toMatchObject({ source: 'docreq', case_id: 'CUBCASE1', contact_id: null, file_count: 3, comment: 'and a pay stub', closed_at: null, notified_at: null, claimed_at: null });
      expect(r.filesParsed.map((f) => f.name)).toEqual(['W2.pdf', 'Lease.pdf', 'Stub.pdf']);
      expect(r.filesParsed[0]).toEqual({ name: 'W2.pdf', item_id: null, item_name: null, landed_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/) });
      const [skew] = await q(
        `SELECT TIMESTAMPDIFF(SECOND, opened_at, UTC_TIMESTAMP()) AS o, TIMESTAMPDIFF(SECOND, last_landed_at, UTC_TIMESTAMP()) AS l
           FROM client_upload_batches WHERE batch_key = ?`, [k]);
      expect(Math.abs(skew.o)).toBeLessThan(10);   // UTC, not the +05:00 session clock
      expect(Math.abs(skew.l)).toBeLessThan(10);
      const [lt] = await q(`SELECT ABS(TIMESTAMPDIFF(SECOND, ?, UTC_TIMESTAMP())) AS d`, [r.filesParsed[2].landed_at.replace('T', ' ').replace('Z', '')]);
      expect(lt.d).toBeLessThan(10);
    });

    test('a blank comment never clears an earlier one', async () => {
      const k = key();
      await docreq(k, 'a.pdf', { comment: 'keep me' });
      await docreq(k, 'b.pdf', { comment: null });
      await docreq(k, 'c.pdf');
      expect((await row(k)).comment).toBe('keep me');
    });

    test('appending refreshes the quiet clock', async () => {
      const k = key();
      await docreq(k, 'a.pdf');
      await age(k, 'last_landed_at', 9);
      await docreq(k, 'b.pdf');
      const [r] = await q('SELECT TIMESTAMPDIFF(SECOND, last_landed_at, UTC_TIMESTAMP()) AS s FROM client_upload_batches WHERE batch_key = ?', [k]);
      expect(r.s).toBeLessThan(10);
    });

    test('the files list caps at MAX_FILES; file_count keeps counting', async () => {
      const k = key();
      await docreq(k, 'first.pdf');
      const filler = JSON.stringify(Array.from({ length: svc.MAX_FILES - 1 }, (_, i) => ({ name: `f${i}.pdf`, item_id: null, item_name: null })));
      await q('UPDATE client_upload_batches SET files = JSON_ARRAY_INSERT(?, \'$[0]\', JSON_OBJECT(\'name\', \'first.pdf\')), file_count = ? WHERE batch_key = ?', [filler, svc.MAX_FILES, k]);
      expect((await row(k)).filesParsed).toHaveLength(svc.MAX_FILES);
      const r1 = await docreq(k, 'over-1.pdf');
      await docreq(k, 'over-2.pdf');
      expect(r1.accepted).toBe(true);
      const r = await row(k);
      expect(r.filesParsed).toHaveLength(svc.MAX_FILES);
      expect(r.filesParsed.some((f) => f.name.startsWith('over-'))).toBe(false);
      expect(r.file_count).toBe(svc.MAX_FILES + 2);
    });

    test('portal: the contact and the item association are stored', async () => {
      const k = key();
      const cid = await contact('Jane');
      await svc.landed(pool, { source: 'portal', batchKey: k, caseId: 'CUBCASE1', contactId: cid, file: { name: 'NFCU.pdf', item_id: 7, item_name: 'Bank statements' } });
      const r = await row(k);
      expect(r.contact_id).toBe(cid);
      expect(r.filesParsed[0]).toMatchObject({ name: 'NFCU.pdf', item_id: 7, item_name: 'Bank statements' });
    });

    test('a closed or notified row refuses (reason closed) and is left exactly as it was', async () => {
      const k = key();
      await docreq(k, 'a.pdf');
      await q('UPDATE client_upload_batches SET closed_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE, last_landed_at = UTC_TIMESTAMP() - INTERVAL 2 MINUTE WHERE batch_key = ?', [k]);
      const before = await row(k);
      expect(await docreq(k, 'late.pdf', { comment: 'new note' })).toEqual({ accepted: false, reason: 'closed' });
      const after = await row(k);
      expect(after).toEqual(before);

      const k2 = key();
      await docreq(k2, 'a.pdf');
      await q('UPDATE client_upload_batches SET notified_at = UTC_TIMESTAMP() WHERE batch_key = ?', [k2]);
      expect(await docreq(k2, 'late.pdf')).toEqual({ accepted: false, reason: 'closed' });
      expect((await row(k2)).file_count).toBe(1);
    });

    test('a key is not a capability: another case, source or contact is refused (reason mismatch), row untouched', async () => {
      const k = key();
      const jane = await contact('Jane');
      const john = await contact('John');
      await svc.landed(pool, { source: 'portal', batchKey: k, caseId: 'CUBCASE1', contactId: jane, file: { name: 'a.pdf' } });
      const before = await row(k);
      expect(await svc.landed(pool, { source: 'portal', batchKey: k, caseId: 'CUBCASE2', contactId: jane, file: { name: 'x.pdf' } })).toEqual({ accepted: false, reason: 'mismatch' });
      expect(await svc.landed(pool, { source: 'portal', batchKey: k, caseId: 'CUBCASE1', contactId: john, file: { name: 'x.pdf' } })).toEqual({ accepted: false, reason: 'mismatch' });
      expect(await svc.landed(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE1', file: { name: 'x.pdf' } })).toEqual({ accepted: false, reason: 'mismatch' });
      expect(await row(k)).toEqual(before);
    });

    test('bad input writes nothing (reason invalid)', async () => {
      for (const o of [
        { source: 'email', batchKey: key(), caseId: 'CUBCASE1', file: { name: 'a.pdf' } },
        { source: 'docreq', batchKey: 'short', caseId: 'CUBCASE1', file: { name: 'a.pdf' } },
        { source: 'docreq', batchKey: 'has space in it ok?', caseId: 'CUBCASE1', file: { name: 'a.pdf' } },
        { source: 'docreq', batchKey: key(), caseId: '', file: { name: 'a.pdf' } },
        { source: 'docreq', batchKey: key(), caseId: 'CUBCASE1', file: { name: '   ' } },
      ]) {
        expect(await svc.landed(pool, o)).toEqual({ accepted: false, reason: 'invalid' });
      }
      expect(await q('SELECT id FROM client_upload_batches')).toEqual([]);
    });
  });

  // ── closeByClient ─────────────────────────────────────────────────────────
  describe('closeByClient', () => {
    test('merges by name, LANDED FIRST, as a multiset; fills a missing item; claims and closes the row', async () => {
      const k = key();
      await docreq(k, 'Scan.pdf', { comment: 'from the page' });
      await docreq(k, 'Scan.pdf');
      await docreq(k, 'W2.pdf');
      const c = await svc.closeByClient(pool, {
        source: 'docreq', batchKey: k, caseId: 'cubcase1',   // the public route passes the raw id
        files: ['scan.pdf', 'Lease.pdf'], fileCount: 2, comment: '',
      });
      expect(c).toEqual({
        status: 'owned', id: expect.any(Number), fileCount: 4, comment: 'from the page',
        files: [
          expect.objectContaining({ name: 'Scan.pdf' }), expect.objectContaining({ name: 'Scan.pdf' }),
          expect.objectContaining({ name: 'W2.pdf' }), { name: 'Lease.pdf', item_id: null, item_name: null },
        ],
      });
      const r = await row(k);
      expect(r.filesParsed.map((f) => f.name)).toEqual(['Scan.pdf', 'Scan.pdf', 'W2.pdf', 'Lease.pdf']);
      expect(r).toMatchObject({ file_count: 4, closed_by: 'client', notified_at: null });
      expect(r.closed_at).not.toBeNull();
      expect(r.claimed_at).not.toBeNull();
    });

    test('the page\'s count wins when it is larger (its list was capped); a page comment replaces the landed one', async () => {
      const k = key();
      const jane = await contact('Jane');
      await svc.landed(pool, { source: 'portal', batchKey: k, caseId: 'CUBCASE1', contactId: jane, file: { name: 'a.pdf' } });
      const c = await svc.closeByClient(pool, {
        source: 'portal', batchKey: k, caseId: 'CUBCASE1', contactId: jane,
        files: [{ name: 'a.pdf', item_id: 7, item_name: 'Bank statements' }, { name: 'b.pdf' }], fileCount: 60, comment: 'final note',
      });
      expect(c.fileCount).toBe(60);
      expect(c.comment).toBe('final note');
      expect(c.files[0]).toMatchObject({ name: 'a.pdf', item_id: 7, item_name: 'Bank statements' });   // filled from the page
    });

    test('every landed call lost: the close creates the row (closed, claimed); a late landed call is then refused', async () => {
      const k = key();
      const c = await svc.closeByClient(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE1', files: ['a.pdf', 'b.pdf'], fileCount: 2 });
      expect(c).toMatchObject({ status: 'owned', fileCount: 2, files: [{ name: 'a.pdf' }, { name: 'b.pdf' }] });
      expect(await row(k)).toMatchObject({ case_id: 'CUBCASE1', closed_by: 'client', file_count: 2 });
      expect(await docreq(k, 'b.pdf')).toEqual({ accepted: false, reason: 'closed' });
    });

    test('no row and no such case → none (nothing created); a key naming another case\'s batch → mismatch', async () => {
      expect(await svc.closeByClient(pool, { source: 'docreq', batchKey: key(), caseId: 'NOPE0000', files: ['a.pdf'] })).toEqual({ status: 'none' });
      expect(await q('SELECT id FROM client_upload_batches')).toEqual([]);
      const k = key();
      await docreq(k, 'a.pdf');
      expect(await svc.closeByClient(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE2', files: ['a.pdf'] })).toEqual({ status: 'mismatch' });
      expect((await row(k)).closed_at).toBeNull();
    });

    test('a row the sweep holds (fresh claim) or finished is TAKEN; lateFiles = the page\'s names it never had', async () => {
      const k = key();
      await docreq(k, 'a.pdf');
      await docreq(k, 'b.pdf');
      await q('UPDATE client_upload_batches SET claimed_at = UTC_TIMESTAMP(), closed_at = UTC_TIMESTAMP(), closed_by = \'sweep\' WHERE batch_key = ?', [k]);
      const c = await svc.closeByClient(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE1', files: ['a.pdf', 'b.pdf', 'big.pdf'] });
      expect(c).toEqual({ status: 'taken', id: expect.any(Number), lateFiles: [{ name: 'big.pdf', item_id: null, item_name: null }] });
      expect((await row(k)).closed_by).toBe('sweep');   // untouched
      await q('UPDATE client_upload_batches SET notified_at = UTC_TIMESTAMP(), claimed_at = UTC_TIMESTAMP() - INTERVAL 1 DAY WHERE batch_key = ?', [k]);
      expect((await svc.closeByClient(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE1', files: ['a.pdf'] })).status).toBe('taken');
    });

    test('a STALE claim without notified_at is claimable again', async () => {
      const k = key();
      await docreq(k, 'a.pdf');
      await q('UPDATE client_upload_batches SET claimed_at = UTC_TIMESTAMP() - INTERVAL 16 MINUTE, closed_at = UTC_TIMESTAMP() - INTERVAL 16 MINUTE, closed_by = \'sweep\' WHERE batch_key = ?', [k]);
      const c = await svc.closeByClient(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE1', files: ['a.pdf'] });
      expect(c.status).toBe('owned');
      expect((await row(k)).closed_by).toBe('client');   // the page did finish
    });
  });

  // ── finishByClient ────────────────────────────────────────────────────────
  describe('finishByClient', () => {
    test('owned: ONE completion on the merged list, closedBy client, the key; then notified_at', async () => {
      const k = key();
      const jane = await contact('Jane');
      await svc.landed(pool, { source: 'portal', batchKey: k, caseId: 'CUBCASE1', contactId: jane, file: { name: 'a.pdf', item_id: 3, item_name: 'Taxes' } });
      const r = await svc.finishByClient(pool, {
        source: 'portal', batchKey: k, caseId: 'CUBCASE1', contactId: jane, clientName: 'Jane Batchtest',
        files: [{ name: 'a.pdf', item_id: 3, item_name: 'Taxes' }, { name: 'b.pdf', item_id: null, item_name: null }], fileCount: 2, comment: null,
      });
      expect(r.status).toBe('owned');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(pool);
      expect(spy.mock.calls[0][1]).toEqual({
        source: 'portal', caseId: 'CUBCASE1', contactId: jane, clientName: 'Jane Batchtest',
        files: [expect.objectContaining({ name: 'a.pdf', item_id: 3, item_name: 'Taxes' }), { name: 'b.pdf', item_id: null, item_name: null }],
        fileCount: 2, comment: null, closedBy: 'client', batchKey: k,
      });
      expect((await row(k)).notified_at).not.toBeNull();
    });

    test('the merged list handed on is capped at NOTICE_FILES; the count is the truth', async () => {
      const k = key();
      const names = Array.from({ length: 55 }, (_, i) => `f${i}.pdf`);
      for (const n of names) await docreq(k, n);
      await svc.finishByClient(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE1', files: names.slice(0, 50), fileCount: 55 });
      const o = spy.mock.calls[0][1];
      expect(o.files).toHaveLength(svc.NOTICE_FILES);
      expect(o.fileCount).toBe(55);
    });

    test('none (no row, no case) → the page\'s own list, as before batches; nothing stamped', async () => {
      const k = key();
      const r = await svc.finishByClient(pool, { source: 'docreq', batchKey: k, caseId: 'NOPE0000', files: ['a.pdf'], fileCount: 1, comment: 'x' });
      expect(r.status).toBe('none');
      expect(spy.mock.calls[0][1]).toEqual({ source: 'docreq', caseId: 'NOPE0000', files: ['a.pdf'], fileCount: 1, comment: 'x', batchKey: k });
    });

    test('mismatch → the page\'s own list, WITHOUT the foreign key in the log', async () => {
      const k = key();
      await docreq(k, 'theirs.pdf');
      await svc.finishByClient(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE2', files: ['mine.pdf'], fileCount: 1 });
      expect(spy.mock.calls[0][1]).toEqual({ source: 'docreq', caseId: 'CUBCASE2', files: ['mine.pdf'], fileCount: 1, comment: undefined });
      expect((await row(k)).notified_at).toBeNull();   // their batch is untouched
    });

    test('a DB failure on close still reports the page\'s list', async () => {
      const broken = { query: async () => { throw new Error('ER_NO_SUCH_TABLE: simulated'); }, getConnection: async () => { throw new Error('ECONNREFUSED: simulated'); } };
      const r = await svc.finishByClient(broken, { source: 'docreq', batchKey: key(), caseId: 'CUBCASE1', files: ['a.pdf'], fileCount: 1 });
      expect(r.status).toBe('error');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1].files).toEqual(['a.pdf']);
    });

    test('taken with nothing new → no completion; taken with late files → one completion of ONLY those', async () => {
      const k = key();
      await docreq(k, 'a.pdf');
      await age(k, 'last_landed_at', 11);
      expect(await svc.sweepLostBatches(pool)).toEqual({ claimed: 1, notified: 1, failed: 0 });
      expect(await docreq(k, 'big.pdf')).toEqual({ accepted: false, reason: 'closed' });   // still uploading when the sweep fired
      spy.mockClear();

      expect(await svc.finishByClient(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE1', files: ['a.pdf'], fileCount: 1 })).toEqual({ status: 'taken', result: null });
      expect(spy).not.toHaveBeenCalled();

      const r = await svc.finishByClient(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE1', files: ['a.pdf', 'big.pdf'], fileCount: 2, comment: 'done' });
      expect(r.status).toBe('taken');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toEqual({
        source: 'docreq', caseId: 'CUBCASE1', files: [{ name: 'big.pdf', item_id: null, item_name: null }],
        fileCount: 1, comment: 'done', closedBy: 'client', batchKey: k,
      });
    });
  });

  // ── sweepLostBatches ──────────────────────────────────────────────────────
  describe('sweepLostBatches', () => {
    test('claims ONLY quiet open rows; reports what landed as a sweep; stamps notified_at', async () => {
      const quiet = key();
      const busy = key();
      await docreq(quiet, 'W2.pdf', { comment: 'taxes' });
      await docreq(quiet, '2025 return.pdf');
      await docreq(busy, 'x.pdf');
      await age(quiet, 'last_landed_at', 11);
      await age(busy, 'last_landed_at', 9);

      expect(await svc.sweepLostBatches(pool)).toEqual({ claimed: 1, notified: 1, failed: 0 });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toEqual({
        source: 'docreq', caseId: 'CUBCASE1',
        files: [expect.objectContaining({ name: 'W2.pdf' }), expect.objectContaining({ name: '2025 return.pdf' })],
        fileCount: 2, comment: 'taxes', closedBy: 'sweep', batchKey: quiet,
      });
      const r = await row(quiet);
      expect(r).toMatchObject({ closed_by: 'sweep' });
      expect(r.closed_at).not.toBeNull();
      expect(r.notified_at).not.toBeNull();
      expect(await row(busy)).toMatchObject({ closed_at: null, claimed_at: null, notified_at: null });

      // a second pass finds nothing
      spy.mockClear();
      expect(await svc.sweepLostBatches(pool)).toEqual({ claimed: 0, notified: 0, failed: 0 });
      expect(spy).not.toHaveBeenCalled();
    });

    test('portal rows: the uploader\'s own name and id ride the completion', async () => {
      const k = key();
      const jane = await contact('Jane');
      await svc.landed(pool, { source: 'portal', batchKey: k, caseId: 'CUBCASE1', contactId: jane, file: { name: 'a.pdf', item_id: 3, item_name: 'Taxes' } });
      await age(k, 'last_landed_at', 11);
      await svc.sweepLostBatches(pool);
      expect(spy.mock.calls[0][1]).toMatchObject({ source: 'portal', contactId: jane, clientName: 'Jane Batchtest', files: [{ name: 'a.pdf', item_id: 3, item_name: 'Taxes' }] });
    });

    test('the retry branch: the page closed it but the completion never finished → re-run once the claim is stale, as the client\'s', async () => {
      const k = key();
      await docreq(k, 'a.pdf');
      await svc.closeByClient(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE1', files: ['a.pdf', 'b.pdf'], fileCount: 2 });
      // fresh claim → not yet
      await age(k, 'closed_at', 11);
      expect((await svc.sweepLostBatches(pool)).claimed).toBe(0);
      // the claimer died 16 min ago
      await age(k, 'claimed_at', 16);
      expect(await svc.sweepLostBatches(pool)).toEqual({ claimed: 1, notified: 1, failed: 0 });
      expect(spy.mock.calls[0][1]).toMatchObject({ closedBy: 'client', files: [{ name: 'a.pdf' }, { name: 'b.pdf' }], fileCount: 2, batchKey: k });
      expect((await row(k)).closed_by).toBe('client');
    });

    test('closed AT CLAIM: a file landing while the sweep is reporting is refused, not appended to a list already read', async () => {
      const k = key();
      await docreq(k, 'a.pdf');
      await age(k, 'last_landed_at', 11);
      let mid;
      spy.mockImplementation(async () => { mid = await docreq(k, 'mid.pdf'); return { sent: true }; });
      await svc.sweepLostBatches(pool);
      expect(mid).toEqual({ accepted: false, reason: 'closed' });
      expect((await row(k)).filesParsed.map((f) => f.name)).toEqual(['a.pdf']);
    });

    test('a closed row is retried only QUIET_MIN after it closed; a notified row never', async () => {
      const k = key();
      await docreq(k, 'a.pdf');
      await q('UPDATE client_upload_batches SET closed_at = UTC_TIMESTAMP() - INTERVAL 9 MINUTE, closed_by = \'client\', last_landed_at = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE batch_key = ?', [k]);
      expect((await svc.sweepLostBatches(pool)).claimed).toBe(0);
      await q('UPDATE client_upload_batches SET notified_at = UTC_TIMESTAMP(), closed_at = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE batch_key = ?', [k]);
      expect((await svc.sweepLostBatches(pool)).claimed).toBe(0);
    });

    test('a fresh claim on a quiet row is respected; a stale one is taken over', async () => {
      const k = key();
      await docreq(k, 'a.pdf');
      await q('UPDATE client_upload_batches SET last_landed_at = UTC_TIMESTAMP() - INTERVAL 30 MINUTE, claimed_at = UTC_TIMESTAMP() - INTERVAL 14 MINUTE WHERE batch_key = ?', [k]);
      expect((await svc.sweepLostBatches(pool)).claimed).toBe(0);
      await age(k, 'claimed_at', 16);
      expect((await svc.sweepLostBatches(pool)).notified).toBe(1);
    });

    test('a completion that throws: counted failed, the claim kept (no retry until stale), notified_at unset', async () => {
      const k = key();
      await docreq(k, 'a.pdf');
      await age(k, 'last_landed_at', 11);
      spy.mockRejectedValueOnce(new Error('boom'));
      expect(await svc.sweepLostBatches(pool)).toEqual({ claimed: 1, notified: 0, failed: 1 });
      const r = await row(k);
      expect(r.notified_at).toBeNull();
      expect(r.claimed_at).not.toBeNull();
      expect((await svc.sweepLostBatches(pool)).claimed).toBe(0);
    });

    test('honours limit, oldest first', async () => {
      const ks = [key(), key(), key()];
      for (const [i, k] of ks.entries()) { await docreq(k, 'a.pdf'); await age(k, 'last_landed_at', 30 - i); }
      expect((await svc.sweepLostBatches(pool, { limit: 2 })).claimed).toBe(2);
      expect(spy.mock.calls.map((c) => c[1].batchKey)).toEqual([ks[0], ks[1]]);
    });

    test('never throws: a dead pool → zeros', async () => {
      const broken = { query: async () => { throw new Error('PROTOCOL_CONNECTION_LOST'); }, getConnection: async () => { throw new Error('ECONNREFUSED'); } };
      await expect(svc.sweepLostBatches(broken)).resolves.toEqual({ claimed: 0, notified: 0, failed: 0 });
    });
  });

  // ── exactly once, under real locks ────────────────────────────────────────
  describe('exactly one completion per row', () => {
    beforeEach(() => {
      // widen the window: each completion takes a moment, as the real one does (Dropbox + SMTP)
      spy.mockImplementation(async () => { await sleep(40); return { sent: true }; });
    });

    test('two sweeps racing over the same due rows: each row completed once', async () => {
      const ks = Array.from({ length: 6 }, () => key());
      for (const k of ks) { await docreq(k, 'a.pdf'); await age(k, 'last_landed_at', 11); }
      const [a, b] = await Promise.all([svc.sweepLostBatches(pool), svc.sweepLostBatches(pool)]);
      expect(a.claimed + b.claimed).toBe(6);
      expect(spy).toHaveBeenCalledTimes(6);
      expect(new Set(spy.mock.calls.map((c) => c[1].batchKey)).size).toBe(6);
      const [n] = await q('SELECT COUNT(*) AS n FROM client_upload_batches WHERE notified_at IS NOT NULL');
      expect(Number(n.n)).toBe(6);
    });

    test('the page\'s close racing the sweep on the same quiet row: exactly one completion (10 rounds)', async () => {
      let owned = 0;
      let swept = 0;
      for (let i = 0; i < 10; i++) {
        spy.mockClear();
        const k = key();
        await docreq(k, 'a.pdf');
        await docreq(k, 'b.pdf');
        await age(k, 'last_landed_at', 11);
        // alternate who starts first
        const startClose = () => svc.finishByClient(pool, { source: 'docreq', batchKey: k, caseId: 'CUBCASE1', files: ['a.pdf', 'b.pdf'], fileCount: 2 });
        let close;
        let sweep;
        if (i % 2) { sweep = svc.sweepLostBatches(pool); close = startClose(); } else { close = startClose(); sweep = svc.sweepLostBatches(pool); }
        const [c, s] = await Promise.all([close, sweep]);
        expect(spy).toHaveBeenCalledTimes(1);
        if (c.status === 'owned') { owned++; expect(s.claimed).toBe(0); } else { swept++; expect(c).toEqual({ status: 'taken', result: null }); expect(s.notified).toBe(1); }
        expect((await row(k)).notified_at).not.toBeNull();
      }
      expect(owned + swept).toBe(10);
    });
  });
});
