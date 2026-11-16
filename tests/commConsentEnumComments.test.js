/**
 * scripts/commConsentEnumComments.js — every path of run() over a scripted
 * connection (the script's own module is real; only the DB is a stand-in),
 * and each new COMMENT pinned against the code it describes
 * (services/optoutService.js and the opt-in writers). The real-engine run is
 * a local 8.4 apply (2026-11-16) + the CHECK on production. Derived from
 * tests/commUnsubTokensCampaignIdComment.test.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('../scripts/commConsentEnumComments');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ALL = S.TABLES.flatMap((t) => t.columns.map((c) => ({ table: t.table, ...c })));
const key = (s) => `${s.table}.${s.column}`;

/** cols: { 'table.column': [successive information_schema rows] }; tables: { table: TABLE_COLLATION } */
function conn(cols, tables = {}) {
  const calls = [];
  const reads = {};
  return {
    calls,
    async query(sql, params) {
      calls.push([sql, params]);
      if (sql === S.SQL.read) {
        const k = `${params[0]}.${params[1]}`;
        const seq = cols[k] || [];
        const c = seq[Math.min(reads[k] || 0, seq.length - 1)];
        reads[k] = (reads[k] || 0) + 1;
        return [c ? [c] : []];
      }
      if (sql === S.SQL.readTable) {
        const coll = params[0] in tables ? tables[params[0]] : S.TABLE_COLLATION;
        return [coll === undefined ? [] : [{ TABLE_COLLATION: coll }]];
      }
      return [[]];
    },
  };
}
const col = (spec, comment, over = {}) => ({ ...spec.expect, COLUMN_COMMENT: comment, ...over });
/** every column at `which` ('old' | 'new'), then (optional) a second read for each */
function world(first, second, over = {}) {
  const out = {};
  for (const s of ALL) {
    const c = (w) => col(s, w === 'old' ? S.OLD_COMMENT : s.comment, over[key(s)] || {});
    out[key(s)] = second ? [c(first), c(second)] : [c(first)];
  }
  return out;
}
const quiet = { log: () => {} };
const alters = (c) => c.calls.filter(([sql]) => /^ALTER TABLE/.test(sql));

test('five columns on two tables, each with a comment', () => {
  expect(ALL.map(key)).toEqual(['comm_consent_events.channel', 'comm_consent_events.action',
    'comm_consent_state.channel', 'comm_consent_state.scope', 'comm_consent_state.state']);
  for (const s of ALL) expect(typeof s.comment).toBe('string');
  expect(S.OLD_COMMENT).toBe('');
});

test('CHECK on empty comments: GO, nothing written', async () => {
  const c = conn(world('old'));
  const r = await S.run(c, { ...quiet });
  expect([r.ok, r.state, alters(c).length]).toEqual([true, 'check', 0]);
});

test('--apply: lock_wait first, then ONE ALTER per table carrying its comments in column order, verified', async () => {
  const c = conn(world('old', 'new'));
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state]).toEqual([true, 'applied-now']);
  const sqls = c.calls.map(([s]) => s);
  const lw = sqls.indexOf(S.SQL.lockWait);
  expect(lw).toBeGreaterThan(-1);
  const a = alters(c);
  expect(a.length).toBe(2);
  for (const [sql] of a) expect(sqls.indexOf(sql)).toBeGreaterThan(lw);
  S.TABLES.forEach((t, i) => {
    expect(a[i][0]).toBe(S.alterSql(t.table, t.columns));
    expect(a[i][1]).toEqual(t.columns.map((x) => x.comment));
  });
  // the definition is restated WITHOUT a charset / collation clause, metadata-only
  for (const t of S.TABLES) {
    const sql = S.alterSql(t.table, t.columns);
    expect(sql).toMatch(/, ALGORITHM=INSTANT$/);
    expect(sql).not.toMatch(/COLLATE|CHARACTER SET/);
    expect(sql.match(/MODIFY COLUMN/g).length).toBe(t.columns.length);
  }
  expect(S.TABLE_COLLATION).toBe('utf8mb4_general_ci');
});

test('already applied: GO, nothing written, even with --apply', async () => {
  const c = conn(world('new'));
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state, alters(c).length]).toEqual([true, 'applied', 0]);
});

test('resumable: one column still empty → one ALTER, that table, that column only', async () => {
  const w = world('new', 'new');
  const spec = ALL.find((s) => key(s) === 'comm_consent_state.scope');
  w[key(spec)] = [col(spec, S.OLD_COMMENT), col(spec, spec.comment)];
  const c = conn(w);
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state]).toEqual([true, 'applied-now']);
  const a = alters(c);
  expect(a).toEqual([[S.alterSql('comm_consent_state', [spec]), [spec.comment]]]);
  expect(a[0][0].match(/MODIFY COLUMN/g).length).toBe(1);
});

test.each([
  ['COLUMN_TYPE', "enum('email','sms','voice')"], ['IS_NULLABLE', 'YES'], ['COLUMN_DEFAULT', 'sms'],
  ['CHARACTER_SET_NAME', 'latin1'], ['COLLATION_NAME', 'utf8mb4_bin'], ['EXTRA', 'auto_increment'],
])('an unexpected %s on one column → NO-GO, nothing written', async (k, v) => {
  const c = conn(world('old', null, { 'comm_consent_events.channel': { [k]: v } }));
  const r = await S.run(c, { apply: true, ...quiet });
  expect([r.ok, r.state, alters(c).length]).toEqual([false, 'unexpected', 0]);
});

test('a table not defaulting to utf8mb4_general_ci, or a missing column / table → NO-GO, nothing written', async () => {
  let c = conn(world('old'), { comm_consent_state: 'utf8mb4_0900_ai_ci' });
  expect((await S.run(c, { apply: true, ...quiet })).state).toBe('unexpected');
  expect(alters(c).length).toBe(0);
  c = conn(world('old'), { comm_consent_events: undefined });
  expect((await S.run(c, { apply: true, ...quiet })).state).toBe('unexpected');
  expect(alters(c).length).toBe(0);
  const w = world('old'); w['comm_consent_state.state'] = [null];
  c = conn(w);
  expect((await S.run(c, { apply: true, ...quiet })).state).toBe('unexpected');
  expect(alters(c).length).toBe(0);
});

test('a comment this script did not write → NO-GO unknown-comment, nothing written', async () => {
  const w = world('old');
  const spec = ALL.find((s) => key(s) === 'comm_consent_events.action');
  w[key(spec)] = [col(spec, 'someone else wrote this')];
  const c = conn(w);
  expect((await S.run(c, { apply: true, ...quiet })).state).toBe('unknown-comment');
  expect(alters(c).length).toBe(0);
});

test('a read-back that does not match → NO-GO verify-failed', async () => {
  let c = conn(world('old', 'old'));
  expect((await S.run(c, { apply: true, ...quiet })).state).toBe('verify-failed');
  const w = world('old', 'new');
  const spec = ALL.find((s) => key(s) === 'comm_consent_state.channel');
  w[key(spec)][1] = col(spec, spec.comment, { COLLATION_NAME: 'utf8mb4_0900_ai_ci' });
  c = conn(w);
  expect((await S.run(c, { apply: true, ...quiet })).state).toBe('verify-failed');
});

test('each comment fits the 1024 cap, is safe to quote, and names its vocabulary', () => {
  for (const s of ALL) {
    expect(s.comment.length).toBeLessThanOrEqual(1024);
    expect(s.comment).not.toMatch(/['\\]/);
  }
  const C = S.COMMENTS;
  expect(C['comm_consent_events.channel']).toMatch(/^sms \| email/);
  expect(C['comm_consent_events.channel']).toContain('MMS is recorded as sms');
  expect(C['comm_consent_events.action']).toMatch(/^opt_out \| opt_in/);
  expect(C['comm_consent_events.action']).toContain('opted_out | opted_in');
  expect(C['comm_consent_state.channel']).toMatch(/^sms \| email/);
  expect(C['comm_consent_state.channel']).toContain('Primary key (channel, destination, scope)');
  expect(C['comm_consent_state.scope']).toContain('sms all | topic, email marketing | topic');
  expect(C['comm_consent_state.state']).toMatch(/^opted_out \| opted_in/);
  expect(C['comm_consent_state.state']).toContain('comm_topics.consent_model');
});

test('the comments describe what optoutService and the opt-in writers really do', () => {
  const oo = read('services/optoutService.js');
  // channel: MMS folds into sms; the two enum values
  expect(oo).toMatch(/const CHANNELS = Object\.freeze\(\{ sms: 'sms', mms: 'sms', email: 'email' \}\)/);
  // action vocabulary and its mapping onto the state enum
  expect(oo).toMatch(/const ACTIONS = Object\.freeze\(\['opt_out', 'opt_in'\]\)/);
  expect(oo).toMatch(/action === 'opt_out' \? 'opted_out' : 'opted_in'/);
  // scope: all is SMS-only, marketing is email-only (no email all, D18)
  expect(oo).toMatch(/scope === 'all'.*if \(c !== 'sms'\) throw/);
  expect(oo).toMatch(/scope === 'marketing'.*if \(c !== 'email'\) throw/);
  // what a send reads: operational sms → all, operational email → nothing; marketing → all | marketing (+ topic)
  expect(oo).toMatch(/if \(klass === 'operational'\) return c === 'sms' \? \['all'\] : null;/);
  expect(oo).toMatch(/const scopes = c === 'sms' \? \['all'\] : \['marketing'\];/);
  // state: opted_out blocks; an opt_in topic needs the topic row at opted_in
  expect(oo).toMatch(/oo_s\.state = 'opted_out'/);
  expect(oo).toMatch(/consent_model = 'opt_in'[\s\S]{0,200}oo_i\.state = 'opted_in'/);
  // the newest (occurred_at, id) wins — the guard in the state upsert
  expect(oo).toMatch(/\(occurred_at, id\) is newer/);
  // opt_in writers: staff only when a signed-in user; the preference page; START while opted out
  expect(oo).toMatch(/action === 'opt_in' && actorOf\(actor\)\.kind !== 'user'\) throw optInRefusal/);
  const us = read('services/unsubService.js');
  expect(us).toMatch(/action: 'opt_in', source: 'pref_page'/);
  const pc = read('services/phoneConsentService.js');
  expect(pc).toMatch(/if \(action === 'opt_in'\) \{[\s\S]{0,400}skipped: 'not_opted_out'/);
  expect(pc).toMatch(/source: 'sms_keyword'/);
  // providers and imports only opt out
  expect(pc).toMatch(/action: 'opt_out', destination: dest, source: 'provider_optout'/);
  expect(pc).not.toMatch(/action: 'opt_in', [^\n]*source: 'provider/);
  const rc = read('routes/api.consent.js');
  expect(rc).toMatch(/action: 'opt_out', source: 'import'/);
  expect(rc).toMatch(/invalid\.push\(\{ index, reason: 'opt_in' \}\)/);
  // the state table's primary key, as dumped
  expect(read('ref/database.sql')).toMatch(/ALTER TABLE `comm_consent_state`\n  ADD PRIMARY KEY \(`channel`,`destination`,`scope`\);/);
});

test('the migration record carries the same statements and comments', () => {
  const rec = read('ref/migrations/2026-11-16_comm_consent_enum_comments.sql');
  expect(rec).toContain(S.SQL.lockWait + ';');
  for (const t of S.TABLES) {
    let sql = S.alterSql(t.table, t.columns);
    for (const c of t.columns) sql = sql.replace('COMMENT ?', `COMMENT '${c.comment}'`);
    expect(rec).toContain(sql + ';');
  }
  expect(rec).toContain('APPLIED BY: node scripts/commConsentEnumComments.js --apply');
});
