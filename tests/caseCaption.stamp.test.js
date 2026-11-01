/**
 * tests/caseCaption.stamp.test.js
 *
 * The court executor's caption stamp, branch by branch, on the fill test's db
 * stub. The UPDATE's predicate on a real engine: tests/caseCaption.mysql.test.js.
 *
 *   npx jest tests/caseCaption.stamp.test.js
 */

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

jest.mock('../lib/domainEvents', () => ({
  emit:         jest.fn(() => Promise.resolve()),
  buildChanges: jest.fn(() => ({})),
  runAsAction:  (_ruleId, fn) => fn(),
  MAX_DEPTH:    4,
}));

const ROW = {
  found: true,
  case_id: 'CaseCap1',
  case_number: '26-44937',
  case_number_full: '26-44937-mar',
  case_caption: null,
  case_type: 'Bankruptcy',
  case_subtype: 'Chapter 7',
  case_chapter: '7',
  primary_contact_id: 333,
  primary_contact_name: 'Jane Q Smith',
};

let resolveResult = { ...ROW };
const courtResolve = require('../lib/courtResolve');
courtResolve.resolveCase = async () => ({ ...resolveResult });
const courtCitation = require('../lib/courtCitation');
courtCitation.checkCitations = () => ({ pass: true, misses: [] });

const { executeCourtActions } = require('../services/courtExecutor');

function makeDb({ captionAffected = 1 } = {}) {
  const updates = [];
  const inserts = [];
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (/FROM court_ai_log WHERE message_id = \?/i.test(flat)) return [[]];
    if (/SELECT `value` FROM app_settings/i.test(flat)) return [[]];
    if (/^UPDATE\b/i.test(flat)) {
      updates.push({ sql: flat, params });
      return [{ affectedRows: /SET case_caption=\?/i.test(flat) ? captionAffected : 1 }];
    }
    if (/^INSERT\b/i.test(flat)) {
      inserts.push({ sql: flat, params });
      return [{ insertId: 88 + inserts.length, affectedRows: 1 }];
    }
    return [[]];
  });
  return { query, updates, inserts };
}

const captionUpdates = (db) => db.updates.filter((u) => /SET case_caption=\?/i.test(u.sql));
// flushChangeRows params: [source_message_id, ai_call_id, court_ai_log_id,
//                          entity_type, entity_id, field, old, new, dry_run]
const captionChanges = (db) => db.inserts
  .filter((i) => /INSERT INTO ai_change_log/i.test(i.sql) && i.params[5] === 'case_caption');

function run(db, overrides = {}, exec = {}) {
  return executeCourtActions(db, {
    payload: {
      message_id: 'caption-run',
      case_number: '26-44937-mar',
      case_name: 'Jane Quincy Smith',
      classification: 'other_notice',
      needs_review: false,
      actions: [],
      ...overrides,
    },
    subject: '26-44937-mar "Certificate of Service" Ch 7',
    body: 'Case Name:   Jane  Quincy Smith\nCase Number: 26-44937-mar\nDocument filed.',
    dryRun: false,
    ...exec,
  });
}

beforeEach(() => { resolveResult = { ...ROW }; });

test('an empty caption takes the court\'s name, guarded, with a change row', async () => {
  const db = makeDb();
  await run(db);
  const ups = captionUpdates(db);
  expect(ups).toHaveLength(1);
  expect(ups[0].sql).toMatch(/case_caption IS NULL OR case_caption=''/i);
  expect(ups[0].params).toEqual(['In re Jane Quincy Smith', 'CaseCap1']);
  const rows = captionChanges(db);
  expect(rows).toHaveLength(1);
  expect(rows[0].params[6]).toBe(null);
  expect(rows[0].params[7]).toBe('In re Jane Quincy Smith');
  expect(rows[0].params[8]).toBe(0);
});

test('a blank-string caption counts as empty', async () => {
  resolveResult = { ...ROW, case_caption: '   ' };
  const db = makeDb();
  await run(db);
  expect(captionUpdates(db)).toHaveLength(1);
});

test('an existing caption stays, whatever the court now says', async () => {
  resolveResult = { ...ROW, case_caption: 'In re Jane Smith' };
  const db = makeDb();
  await run(db);
  expect(captionUpdates(db)).toHaveLength(0);
  expect(captionChanges(db)).toHaveLength(0);
});

test('a name the email does not contain is never stamped', async () => {
  const db = makeDb();
  await run(db, { case_name: 'Somebody Else' });
  expect(captionUpdates(db)).toHaveLength(0);
});

test('a "v." name stays off a main bankruptcy case', async () => {
  const db = makeDb();
  await run(db, { case_name: 'Cohen v. Boren' }, { body: 'Case Name: Cohen v. Boren' });
  expect(captionUpdates(db)).toHaveLength(0);
});

test('an adversary keeps the court\'s text', async () => {
  resolveResult = { ...ROW, case_subtype: 'Adversary Proceeding' };
  const db = makeDb();
  await run(db, { case_name: 'Cohen v. Boren' }, { body: 'Case Name: Cohen v. Boren' });
  expect(captionUpdates(db)[0].params).toEqual(['Cohen v. Boren', 'CaseCap1']);
});

test('dry run writes nothing to cases and records a plan row', async () => {
  const db = makeDb();
  await run(db, {}, { dryRun: true });
  expect(captionUpdates(db)).toHaveLength(0);
  const rows = captionChanges(db);
  expect(rows).toHaveLength(1);
  expect(rows[0].params[8]).toBe(1);
});

test('losing the race to another writer records no change', async () => {
  const db = makeDb({ captionAffected: 0 });
  await run(db);
  expect(captionUpdates(db)).toHaveLength(1);
  expect(captionChanges(db)).toHaveLength(0);
});

test('a row queued for review stamps nothing until it re-runs', async () => {
  const db = makeDb();
  const res = await run(db, { needs_review: true, review_reason: 'look' });
  expect(res.outcome).toBe('queued');
  expect(captionUpdates(db)).toHaveLength(0);
});

test('an email with no name falls back to the caption without its "In re"', async () => {
  resolveResult = { ...ROW, case_caption: 'In re Jane Quincy Smith' };
  const db = makeDb();
  await run(db, { case_name: null });
  const log = db.inserts.find((i) => /INSERT INTO court_ai_log/i.test(i.sql));
  expect(log.params).toContain('Jane Quincy Smith');
  expect(log.params).not.toContain('In re Jane Quincy Smith');
});
