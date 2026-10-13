/**
 * tests/courtExtract.dedupe.test.js
 *
 * court_extract CONTENT DEDUPE (2026-10-13) — lib/internal_functions/court.js
 * claims each court email's content in court_email_hashes BEFORE the AI call,
 * and services/courtExecutor.logDuplicateContent records the skip.
 *
 *   npx jest tests/courtExtract.dedupe.test.js
 *
 * Contract under test:
 *   FIRST SIGHTING  — the INSERT IGNORE takes → normal processing (AI called).
 *   DUPLICATE       — the hash is owned by a DIFFERENT message_id → NO AI call;
 *                     one court_ai_log row: our message_id, outcome 'none',
 *                     review_reason 'duplicate_of:<owner>', the effective
 *                     dry_run flag, null actions/payload.
 *   RE-EXTRACT      — the hash is owned by the SAME message_id (the review
 *                     queue's Re-extract replays the original id) → proceeds.
 *   TEST IDS        — /-test-/ ids bypass the check AND the insert entirely.
 *   FAIL-OPEN       — a hash-layer DB error, or a failed duplicate-log write,
 *                     falls through to normal processing.
 *
 * Harness: the real court.js + the real courtExecutor helpers over a
 * regex-routed db stub (every query the paths emit is answered explicitly;
 * anything else throws). aiService.call is the only stubbed dependency — it
 * returns no JSON, so "processed normally" lands on logExtractFailure's
 * extract_failed row (real code) without dragging the executor in.
 */

'use strict';

const crypto    = require('crypto');
const aiService = require('../services/aiService');
const fns       = require('../lib/internal_functions/court');

// Independent oracle for the hash — the SPEC's formula, deliberately NOT the
// module's helper: sha256(normWs(subject) + '\n' + normWs(body)), hex.
function specHash(subject, body) {
  const ws = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${ws(subject)}\n${ws(body)}`, 'utf8').digest('hex');
}

const SUBJECT = '26-48181-mlo "Trustee Services Rendered Pursuant to 330(e)" Ch 7';
const BODY =
  'Notice of Electronic Filing\n\nThe following transaction was received from ' +
  'mlo, entered on 9/14/2026 at 7:11 AM EDT and filed on 9/14/2026\n' +
  'Case Name: Jane Debtor\nCase Number: 26-48181-mlo\n';

/** court_ai_log INSERT → { column: param } using the statement's own column list. */
function calRow(sql, params) {
  const cols = /court_ai_log\s*\(([^)]+)\)/.exec(sql)[1].split(',').map((c) => c.trim());
  const row = {};
  cols.forEach((c, i) => { row[c] = params[i]; });
  return row;
}

function makeDb({ live = '1', owners = {}, hashError = null, failDuplicateLog = false } = {}) {
  const hashes  = new Map(Object.entries(owners)); // content_hash → message_id
  const hashOps = [];
  const calLog  = [];
  const query = jest.fn(async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/FROM app_settings WHERE `key` = \? LIMIT 1/.test(s)) {
      return [[{ value: live }]];                       // getSetting reads [[row]]
    }
    if (/court_email_hashes/.test(s)) {
      hashOps.push({ sql: s, params });
      if (hashError) throw hashError;
      if (/^INSERT IGNORE INTO court_email_hashes \(content_hash, message_id\) VALUES \(\?, \?\)$/.test(s)) {
        if (hashes.has(params[0])) return [{ affectedRows: 0 }];
        hashes.set(params[0], params[1]);
        return [{ affectedRows: 1 }];
      }
      if (/^SELECT message_id FROM court_email_hashes WHERE content_hash = \? LIMIT 1$/.test(s)) {
        return [hashes.has(params[0]) ? [{ message_id: hashes.get(params[0]) }] : []];
      }
    }
    if (/^INSERT INTO court_ai_log\b/.test(s)) {
      const row = calRow(s, params);
      if (failDuplicateLog && /^duplicate_of:/.test(row.review_reason || '')) {
        throw new Error('simulated court_ai_log write failure');
      }
      calLog.push(row);
      return [{ insertId: 500 + calLog.length, affectedRows: 1 }];
    }
    throw new Error('unexpected query: ' + s);
  });
  return { query, hashes, hashOps, calLog };
}

const run = (db, overrides = {}) => fns.court_extract({
  message_id: 'gm-orig',
  subject:    SUBJECT,
  from_email: 'cmecf_info@mieb.uscourts.gov',
  body:       BODY,
  ...overrides,
}, db);

const realCall = aiService.call;
let logSpy, errSpy;
beforeEach(() => {
  aiService.call = jest.fn(async () => ({ ok: false, error: 'stub_no_json', callId: 91 }));
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});
afterAll(() => { aiService.call = realCall; });

describe('court_extract content dedupe', () => {
  test('(a) first sighting: claims the hash for its message_id, then processes normally', async () => {
    const db = makeDb();
    const res = await run(db);

    expect(db.hashOps[0].params).toEqual([specHash(SUBJECT, BODY), 'gm-orig']);
    expect(db.hashes.get(specHash(SUBJECT, BODY))).toBe('gm-orig');
    expect(db.hashOps).toHaveLength(1);                 // insert took — no owner lookup
    expect(aiService.call).toHaveBeenCalledTimes(1);
    expect(res.output.skipped).toBe('extract_failed');  // the normal path's soft result
    expect(db.calLog).toHaveLength(1);
    expect(db.calLog[0].review_reason).toBe('extract_failed:stub_no_json');
  });

  test('(b) duplicate delivery: NO AI call, one closing duplicate_of row on OUR message_id', async () => {
    const db = makeDb({ owners: { [specHash(SUBJECT, BODY)]: 'gm-orig' } });
    const res = await run(db, { message_id: 'gm-copy' });

    expect(aiService.call).not.toHaveBeenCalled();
    expect(db.calLog).toHaveLength(1);
    expect(db.calLog[0]).toEqual({
      message_id:       'gm-copy',
      ai_call_id:       null,
      dry_run:          0,               // court_ingest_live = '1'
      classification:   null,
      case_number:      null,
      resolved_case_id: null,
      case_name:        null,
      actions_json:     null,
      citations_json:   null,
      skipped_json:     null,
      outcome:          'none',
      review_reason:    'duplicate_of:gm-orig',
      raw_response:     null,
    });
    expect(res).toEqual({
      success: true,
      output: {
        dry_run:         false,
        skipped:         'duplicate_content',
        duplicate_of:    'gm-orig',
        outcome:         'none',
        court_ai_log_id: 501,
        review_reason:   'duplicate_of:gm-orig',
      },
    });
    expect(db.hashes.get(specHash(SUBJECT, BODY))).toBe('gm-orig'); // owner unchanged
  });

  test('(b) duplicate row carries the EFFECTIVE dry-run flag (court_ingest_live off → dry_run 1)', async () => {
    const db = makeDb({ live: '0', owners: { [specHash(SUBJECT, BODY)]: 'gm-orig' } });
    const res = await run(db, { message_id: 'gm-copy' });
    expect(aiService.call).not.toHaveBeenCalled();
    expect(db.calLog[0].dry_run).toBe(1);
    expect(res.output.dry_run).toBe(true);
  });

  test('(b) two deliveries through one db: the first is extracted, the second skipped', async () => {
    const db = makeDb();
    await run(db, { message_id: 'gm-first' });
    // Transport re-wrapping (different line breaks / trailing blanks) must not
    // split one notice into two hashes.
    const rewrapped = BODY.replace(/\n/g, '\r\n  ').replace('received from mlo', 'received from\n mlo') + '\n\n';
    const res = await run(db, { message_id: 'gm-second', body: rewrapped, subject: `  ${SUBJECT} ` });

    expect(aiService.call).toHaveBeenCalledTimes(1);
    expect(res.output.skipped).toBe('duplicate_content');
    expect(res.output.duplicate_of).toBe('gm-first');
    expect(db.calLog.map((r) => [r.message_id, r.outcome])).toEqual([
      ['gm-first', 'queued'],   // extract_failed under the stub = processed normally
      ['gm-second', 'none'],
    ]);
  });

  test('different content under a different id is NOT a duplicate', async () => {
    const db = makeDb({ owners: { [specHash(SUBJECT, BODY)]: 'gm-orig' } });
    const res = await run(db, { message_id: 'gm-other', body: BODY.replace('7:11 AM', '7:12 AM') });
    expect(aiService.call).toHaveBeenCalledTimes(1);
    expect(res.output.skipped).toBe('extract_failed');
  });

  test('(c) same message_id again (Re-extract of the original) proceeds normally', async () => {
    const db = makeDb({ owners: { [specHash(SUBJECT, BODY)]: 'gm-orig' } });
    const res = await run(db, { message_id: 'gm-orig' });

    expect(db.hashOps.map((o) => o.sql.split(' ')[0])).toEqual(['INSERT', 'SELECT']); // ignored → owner looked up
    expect(aiService.call).toHaveBeenCalledTimes(1);
    expect(res.output.skipped).toBe('extract_failed');
    expect(db.calLog.some((r) => /^duplicate_of:/.test(r.review_reason || ''))).toBe(false);
  });

  test('(d) -test- ids bypass the check AND the insert', async () => {
    // Seeded so that a check, if it ran, WOULD report a duplicate.
    const db = makeDb({ owners: { [specHash(SUBJECT, BODY)]: 'gm-orig' } });
    const res = await run(db, { message_id: 'gm-orig-test-mg8k2x-a1b2c3' });

    expect(db.hashOps).toHaveLength(0);
    expect(db.hashes.size).toBe(1);
    expect(aiService.call).toHaveBeenCalledTimes(1);
    expect(res.output.skipped).toBe('extract_failed');
  });

  test('ids that cannot key the hash (missing, or longer than the column) skip dedupe', async () => {
    const db = makeDb({ owners: { [specHash(SUBJECT, BODY)]: 'gm-orig' } });
    await run(db, { message_id: '' });
    await run(db, { message_id: 'x'.repeat(256) });
    expect(db.hashOps).toHaveLength(0);
    expect(aiService.call).toHaveBeenCalledTimes(2);
  });

  test('(e) hash-layer DB error falls through to normal processing', async () => {
    const err = Object.assign(new Error("Table 'court_email_hashes' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
    const db = makeDb({ hashError: err });
    const res = await run(db, { message_id: 'gm-copy' });

    expect(db.hashOps).toHaveLength(1);
    expect(aiService.call).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(true);
    expect(res.output.skipped).toBe('extract_failed');
    expect(errSpy.mock.calls.some((c) => /content dedupe failed/.test(String(c[0])))).toBe(true);
  });

  test('(e) a failed duplicate-log write falls through to normal processing', async () => {
    const db = makeDb({ owners: { [specHash(SUBJECT, BODY)]: 'gm-orig' }, failDuplicateLog: true });
    const res = await run(db, { message_id: 'gm-copy' });

    expect(aiService.call).toHaveBeenCalledTimes(1);
    expect(res.output.skipped).toBe('extract_failed');
    expect(db.calLog.map((r) => r.review_reason)).toEqual(['extract_failed:stub_no_json']);
  });
});
