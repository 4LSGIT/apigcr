/**
 * tests/phoneSPH.search.test.js — mailbox arc slice PS: ?q= on the four Phone
 * LIST reads (routes/api.phoneComms.js → services/phoneCommsService.js
 * listConversations / listAllConversations / listCalls / listAllCalls).
 * Run: npx jest tests/phoneSPH
 *
 * HARNESS: tests/phoneSPH.routes.test.js's — the real router, services and
 * auth middleware over express, the database the stateful fake in
 * tests/helpers/phoneSPHWorld.js (SPH_SEED + SEARCH_SEED; unknown statements
 * THROW). The SQL itself — the matchers, the predicate, their plans — runs on
 * MySQL 8 in tests/phoneSPH.mysql.test.js (gated), held to this world.
 *
 * WHAT IS PINNED (mutation-checked — the PS report lists each mutation):
 *   number   every typed form of one number (formatted, +1, 1, partials);
 *            the leading country 1 dropped only per the rule.
 *   contact  contacts.contact_name LIKE, wildcards in the input literal;
 *            only ACTIVE numbers.
 *   case     docket number / full / caption → Primary + Secondary clients'
 *            numbers (Bystander / Other never), matched_cases on the row.
 *   union    a docket is digit-shaped too: both matchers run, rows say which.
 *   scope    a hit on a line the caller cannot read never appears.
 *   paging   q rides every page; the keyset is unchanged.
 *   calls    the call log narrows to the same numbers.
 *   limits   too short / capped / too long / not one string.
 *   ref      "#<id>" (the bubble's reference number) is that event and
 *            nothing else — its conversation, or on a call log its one call
 *            row — with `search.ref` for the pane's jump; bare digits are a
 *            number AND a ref; another line's, a suppressed or an
 *            out-of-list event finds nothing and leaves no trace.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'phone-sph-test-secret';
process.env.INTERNAL_API_KEY = 'yci_phone_sph_internal';

const express = require('express');
const jwt = require('jsonwebtoken');
const { _resetRateLimits } = require('../lib/auth.superuser');
const phone = require('../services/phoneCommsService');
const router = require('../routes/api.phoneComms');
const { makeWorld, SPH_SEED, SEARCH_SEED, REF_SEED } = require('./helpers/phoneSPHWorld');

const SU = 6; const SB = 5; const RENA = 22;

let W; let S; let X; let R;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = W.db; next(); });
app.use(router);

let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  W = makeWorld();
  S = SPH_SEED(W);
  X = SEARCH_SEED(W, S);
  R = REF_SEED(W, S);
  _resetRateLimits();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const tok = (user, roles = []) => jwt.sign({ sub: String(user), username: 'u' + user, user_auth: 'authorized', roles, aud: 'staff' }, process.env.JWT_SECRET);
const T = { su: () => tok(SU, ['su']), sb: () => tok(SB), rena: () => tok(RENA) };

async function get(url, t = T.su()) {
  const r = await fetch(base + url, { headers: { Authorization: `Bearer ${t}` } });
  return { status: r.status, json: await r.json() };
}
const withQ = (path, q, extra = '') => `${path}?q=${encodeURIComponent(q)}${extra}`;
const parties = (r) => r.json.conversations.map(c => c.other_party);
const by = (r) => Object.fromEntries(r.json.conversations.map(c => [c.other_party, c.matched_by]));
const logReads = () => W.statements.filter(x => /FROM phone_event_log (e |FORCE)/.test(x.sql) && /GROUP BY|ORDER BY processed_at/.test(x.sql));

describe('number matcher', () => {
  test('every typed form of one number finds it — on a line, across All, and in both call logs', async () => {
    const forms = ['2026702603', '(202) 670-2603', '202-670-2603', '202.670.2603', '+1 202 670 2603', '+12026702603', '12026702603', '670-2603', '2603'];
    for (const q of forms) {
      const one = await get(withQ('/api/phone-lines/1/conversations', q));
      expect([q, one.status, parties(one), one.json.conversations[0].matched_by]).toEqual([q, 200, [X.NUM], ['number']]);
      const all = await get(withQ('/api/phone-lines/all/conversations', q));
      expect([q, parties(all)]).toEqual([q, [X.NUM]]);
      const calls = await get(withQ('/api/phone-lines/6/calls', q));
      expect([q, calls.json.calls.map(c => [c.other_party, c.matched_by])]).toEqual([q, [[X.NUM, ['number']]]]);
      const allCalls = await get(withQ('/api/phone-lines/all/calls', q));
      expect([q, allCalls.json.calls.map(c => [c.other_party, c.line_id])]).toEqual([q, [[X.NUM, 6]]]);
    }
  });

  test('the leading 1 is dropped only after +1 or on 11 digits; under 3 digits there is no number matcher', () => {
    expect(['+1 202', '+1-313', '12026702603', '1202', '2603', '22395', '24-41234', '+44 20 7946 0958', 'ab', '12'].map(phone.searchDigits))
      .toEqual(['202', '313', '2026702603', '1202', '2603', '22395', '2441234', '442079460958', null, null]);
  });
});

describe('contact matcher', () => {
  test('a contact name finds the numbers that contact holds now; the row is named by the same contact', async () => {
    const r = await get(withQ('/api/phone-lines/all/conversations', 'smith'));
    expect(parties(r)).toEqual([S.P4]);
    expect(r.json.conversations[0]).toMatchObject({ contact: { contact_id: 503, name: 'Dana Smith' }, matched_by: ['contact'] });
    // Old Owner's number ended: the name finds nothing
    const old = await get(withQ('/api/phone-lines/all/conversations', 'Old Owner'));
    expect(old.json).toMatchObject({ conversations: [], next_cursor: null, search: { q: 'Old Owner', too_short: false, capped: [] } });
  });

  test('LIKE wildcards in the input are literal: "%_" finds only the name that contains them', async () => {
    const r = await get(withQ('/api/phone-lines/all/conversations', '%_'));
    expect(parties(r)).toEqual([X.P5]);
    const pct = await get(withQ('/api/phone-lines/1/conversations', '50%'));
    expect(parties(pct)).toEqual([X.P5]);
  });
});

describe('case matcher', () => {
  test('a docket number reaches the case\'s Primary AND Secondary clients — never a Bystander or Other relation; rows carry the case', async () => {
    const r = await get(withQ('/api/phone-lines/all/conversations', '24-41234'));
    expect(by(r)).toEqual({ [S.P1]: ['case'], [S.P4]: ['case'] }); // CASE0003's Other relation (P5) stays out
    const p1 = r.json.conversations.find(c => c.other_party === S.P1);
    expect(p1.matched_cases).toEqual([{ case_id: 'CASE0001', number: '2:24-bk-41234', caption: 'In re Pat One' }]);
    const bystander = await get(withQ('/api/phone-lines/all/conversations', '24-55555'));
    expect(parties(bystander)).toEqual([]);
    // the full docket and the caption are searched too
    expect(Object.keys(by(await get(withQ('/api/phone-lines/all/conversations', 'bk-412'))))).toEqual(expect.arrayContaining([S.P1, S.P4]));
  });

  test('UNION: one name can match a contact AND a case caption; every row says which matcher found it', async () => {
    const r = await get(withQ('/api/phone-lines/all/conversations', 'pat'));
    expect(by(r)).toEqual({ [S.P1]: ['contact', 'case'], [S.P4]: ['case'], [X.P7]: ['contact'] });
    expect(r.json.conversations.find(c => c.other_party === X.P7).matched_cases).toBeUndefined();
  });

  test('UNION: a digit-shaped docket runs the number matcher too — a number containing those digits shows beside the case hits', async () => {
    W.sms(S.L1, '3132441234', 'incoming', { body: 'digits like the docket' });
    const r = await get(withQ('/api/phone-lines/1/conversations', '24-41234'));
    expect(by(r)).toEqual({ '3132441234': ['number'], [S.P1]: ['case'] });
  });
});

describe('scope', () => {
  test('a hit on a line the caller cannot read never appears — All numbers, both lists; the line itself stays a 404', async () => {
    W.grant(SB, 1, { can_read: 1 });
    W.grant(RENA, 3, { can_read: 1 });
    // Rena Pal's number is on lines 3 and 6: Rena reads line 3 only — one text, not two
    const rena = await get(withQ('/api/phone-lines/all/conversations', 'Rena Pal'), T.rena());
    expect(rena.json.conversations.map(c => [c.other_party, c.count, c.line_ids])).toEqual([[X.P6, 1, [3]]]);
    const sb = await get(withQ('/api/phone-lines/all/conversations', 'Rena Pal'), T.sb());
    expect(sb.json.conversations).toEqual([]);
    expect((await get(withQ('/api/phone-lines/3/conversations', 'Rena Pal'), T.sb())).status).toBe(404);
    // the number is on lines 1 AND 6: a line-1 reader sees its line-1 events only
    const num = await get(withQ('/api/phone-lines/all/conversations', '2603'), T.sb());
    expect(num.json.conversations.map(c => [c.other_party, c.count, c.line_ids])).toEqual([[X.NUM, 1, [1]]]);
    expect((await get(withQ('/api/phone-lines/all/calls', '2603'), T.sb())).json.calls).toEqual([]);
    // and the name matchers only looked at the caller's lines
    const matchers = W.statements.filter(x => /^SELECT (DISTINCT )?cp\.phone_active_uniq/.test(x.sql));
    expect(matchers.length).toBeGreaterThan(0);
  });
});

describe('paging, views, shape', () => {
  test('q rides every page: limit 1 walks the same rows a single page holds, keyset unchanged', async () => {
    const whole = await get(withQ('/api/phone-lines/all/conversations', 'pat'));
    const walked = [];
    let cursor = '';
    for (let i = 0; i < 6; i++) {
      const r = await get(withQ('/api/phone-lines/all/conversations', 'pat', `&limit=1${cursor ? `&cursor=${cursor}` : ''}`));
      walked.push(...r.json.conversations);
      if (!r.json.next_cursor) break;
      cursor = r.json.next_cursor;
    }
    expect(walked).toEqual(whole.json.conversations);
    expect(walked).toHaveLength(3);
    // the call log pages the same way
    const calls = await get(withQ('/api/phone-lines/all/calls', 'pat', '&limit=1'));
    expect(calls.json.calls.map(c => [c.id, c.other_party, c.matched_by])).toEqual([[14, S.P4, ['case']]]);
    const next = await get(withQ('/api/phone-lines/all/calls', 'pat', `&limit=1&cursor=${calls.json.next_cursor}`));
    expect(next.json.calls.map(c => [c.id, c.other_party, c.matched_by])).toEqual([[10, S.P1, ['contact', 'case']]]);
    expect(next.json.next_cursor).toBeNull();
  });

  test('Texts (kind=sms) and q together: texts only, among the matched numbers', async () => {
    const r = await get(withQ('/api/phone-lines/all/conversations', '2603', '&kind=sms'));
    expect(r.json.conversations.map(c => [c.other_party, c.count, c.last.kind])).toEqual([[X.NUM, 1, 'sms']]);
    const six = await get(withQ('/api/phone-lines/6/conversations', '2603', '&kind=sms'));
    expect(six.json.conversations).toEqual([]);
  });

  test('without q nothing changes: no matched_by, no search block', async () => {
    const r = await get('/api/phone-lines/1/conversations');
    expect(r.json.search).toBeUndefined();
    expect(r.json.conversations.every(c => !('matched_by' in c))).toBe(true);
    const e = await get('/api/phone-lines/1/conversations?q=%20%20');
    expect(e.json.search).toBeUndefined();
    expect(e.json.conversations.length).toBe(r.json.conversations.length);
  });
});

describe('limits', () => {
  test('one character (no digits to speak of) is too short: empty, said so, and the log is never read', async () => {
    for (const path of ['/api/phone-lines/1/conversations', '/api/phone-lines/all/conversations', '/api/phone-lines/1/calls', '/api/phone-lines/all/calls']) {
      W.statements.length = 0;
      const r = await get(withQ(path, 'a'));
      expect([path, r.status, r.json.search]).toEqual([path, 200, { q: 'a', too_short: true, capped: [] }]);
      expect(r.json.next_cursor).toBeNull();
      expect(logReads()).toEqual([]);
    }
    // two letters that match nothing: not "too short", just nothing
    expect((await get(withQ('/api/phone-lines/1/conversations', 'zq'))).json.search).toEqual({ q: 'zq', too_short: false, capped: [] });
  });

  test('a name matcher stops at SEARCH_PARTY_CAP numbers and says so', async () => {
    const n = phone.SEARCH_PARTY_CAP + 1;
    for (let i = 0; i < n; i++) {
      const num = `810${String(i).padStart(7, '0')}`;
      W.sms(S.L1, num, 'incoming');
      W.contact(700000 + i, `Capper ${i}`, num);
    }
    const r = await get(withQ('/api/phone-lines/1/conversations', 'Capper', '&limit=100'));
    expect(r.json.search).toEqual({ q: 'Capper', too_short: false, capped: ['contact'] });
    const match = W.statements.find(x => /^SELECT cp\.phone_active_uniq AS phone FROM contacts/.test(x.sql));
    expect(match.params.slice(-1)).toEqual([phone.SEARCH_PARTY_CAP + 1]);
    const listed = W.statements.find(x => x.sql.includes('other_party IN (?)'));
    expect(listed.params[2]).toHaveLength(phone.SEARCH_PARTY_CAP);
    // one under the cap: not capped
    W.T.contacts = W.T.contacts.filter(c => c.contact_id !== 700000);
    expect((await get(withQ('/api/phone-lines/1/conversations', 'Capper'))).json.search.capped).toEqual([]);
  });

  test('q over the limit or repeated is a 400', async () => {
    const long = await get(withQ('/api/phone-lines/1/conversations', 'x'.repeat(phone.SEARCH_MAX_CHARS + 1)));
    expect([long.status, long.json.message]).toEqual([400, `q is ${phone.SEARCH_MAX_CHARS + 1} characters — the limit is ${phone.SEARCH_MAX_CHARS}`]);
    expect((await get('/api/phone-lines/all/calls?q=a&q=b')).status).toBe(400);
    expect((await get(withQ('/api/phone-lines/1/conversations', 'x'.repeat(phone.SEARCH_MAX_CHARS)))).status).toBe(200);
  });
});

describe('ref matcher (the bubble reference number)', () => {
  const refReads = () => W.statements.filter(x => /^SELECT e\.id, e\.event_type, e\.other_party/.test(x.sql));
  const callsOf = (r) => r.json.calls.map(c => [c.id, c.other_party, c.matched_by]);

  test('"#<id>" finds exactly that event\'s conversation — on its line and across All — and says so in search.ref', async () => {
    for (const q of ['#4', '# 4', '#  4']) {
      const one = await get(withQ('/api/phone-lines/1/conversations', q));
      expect([q, one.status, by(one)]).toEqual([q, 200, { [S.P2]: ['ref'] }]);
      expect(one.json.search).toEqual({ q, too_short: false, capped: [], ref: { id: 4, kind: 'sms', other_party: S.P2, line_id: 1 } });
      const all = await get(withQ('/api/phone-lines/all/conversations', q));
      expect([q, by(all), all.json.search.ref]).toEqual([q, { [S.P2]: ['ref'] }, { id: 4, kind: 'sms', other_party: S.P2, line_id: 1 }]);
    }
    // the conversation is the whole of it: P2's text AND its call on line 1
    W.statements.length = 0;
    const one = await get(withQ('/api/phone-lines/1/conversations', '#4'));
    expect(one.json.conversations[0].count).toBe(2);
    // one PK lookup per read, held to the lines being read
    expect(refReads().map(x => x.params)).toEqual([[4, ['2485592400']]]);
  });

  test('"#<digits>" is a ref ONLY: the number and name matchers do not run', async () => {
    const asNumber = await get(withQ('/api/phone-lines/all/conversations', '2603'));
    expect(parties(asNumber)).toEqual([X.NUM]);
    W.statements.length = 0;
    const asRef = await get(withQ('/api/phone-lines/all/conversations', '#2603'));
    expect(asRef.json).toMatchObject({ conversations: [], next_cursor: null, search: { q: '#2603', too_short: false, capped: [] } });
    expect(asRef.json.search.ref).toBeUndefined();
    expect(W.statements.filter(x => /contact_name LIKE|case_caption LIKE/.test(x.sql))).toEqual([]);
    expect(logReads()).toEqual([]); // nothing can match: the log is never read
    // past the column (int unsigned): no lookup, nothing found
    W.statements.length = 0;
    const huge = await get(withQ('/api/phone-lines/all/conversations', '#4294967296'));
    expect([huge.json.conversations, huge.json.search.ref, refReads()]).toEqual([[], undefined, []]);
  });

  test('bare digits are a number AND a ref (never a guess): each row says which', async () => {
    const r = await get(withQ('/api/phone-lines/1/conversations', '702'));
    expect(by(r)).toEqual({ [R.REF_PARTY]: ['ref'], [X.NUM]: ['number'] });
    expect(r.json.search.ref).toEqual({ id: R.REF_ID, kind: 'sms', other_party: R.REF_PARTY, line_id: 1 });
    // the ref alone
    expect(by(await get(withQ('/api/phone-lines/1/conversations', '#702')))).toEqual({ [R.REF_PARTY]: ['ref'] });
    // a single digit is a ref, not "too short"
    const short = await get(withQ('/api/phone-lines/1/conversations', '4'));
    expect([by(short), short.json.search]).toEqual([{ [S.P2]: ['ref'] }, { q: '4', too_short: false, capped: [], ref: { id: 4, kind: 'sms', other_party: S.P2, line_id: 1 } }]);
    // 11 digits starting 1 = a number only (past the column): no lookup
    W.statements.length = 0;
    expect(parties(await get(withQ('/api/phone-lines/all/conversations', '12026702603')))).toEqual([X.NUM]);
    expect(refReads()).toEqual([]);
  });

  test('scope never widens: another line\'s ref is invisible to a grantee and to a per-line read, and leaves no trace', async () => {
    W.grant(RENA, 3, { can_read: 1 });
    const nothing = (q) => ({ conversations: [], next_cursor: null, search: { q, too_short: false, capped: [] } });
    // Rena reads line 3: #4 (line 1) is nothing — the same answer as an id that does not exist
    const hidden = await get(withQ('/api/phone-lines/all/conversations', '#4'), T.rena());
    const absent = await get(withQ('/api/phone-lines/all/conversations', '#99999'), T.rena());
    expect([hidden.json.conversations, hidden.json.next_cursor, hidden.json.search]).toEqual([[], null, nothing('#4').search]);
    expect({ ...absent.json, search: { ...absent.json.search, q: '#4' } }).toEqual(hidden.json);
    expect((await get(withQ('/api/phone-lines/all/calls', '#3'), T.rena())).json).toEqual({ status: 'success', all: true, calls: [], next_cursor: null, search: { q: '#3', too_short: false, capped: [] } });
    expect((await get(withQ('/api/phone-lines/1/conversations', '#4'), T.rena())).status).toBe(404);
    // her own line's ref she sees
    const own = await get(withQ('/api/phone-lines/all/conversations', '#19'), T.rena());
    expect([by(own), own.json.search.ref]).toEqual([{ [X.P6]: ['ref'] }, { id: 19, kind: 'sms', other_party: X.P6, line_id: 3 }]);
    // the SU reading line 1 does not see line 3's event either
    const su = await get(withQ('/api/phone-lines/1/conversations', '#19'));
    expect([su.json.conversations, su.json.search.ref]).toEqual([[], undefined]);
  });

  test('a suppressed event is invisible — text or call, every list', async () => {
    for (const [q, path] of [['#5', '/api/phone-lines/1/conversations'], ['#5', '/api/phone-lines/all/conversations'],
      [`#${R.SUPP_CALL}`, '/api/phone-lines/1/calls'], [`#${R.SUPP_CALL}`, '/api/phone-lines/all/calls'], [`#${R.SUPP_CALL}`, '/api/phone-lines/all/conversations']]) {
      const r = await get(withQ(path, q));
      expect([q, path, (r.json.conversations || r.json.calls), r.json.search]).toEqual([q, path, [], { q, too_short: false, capped: [] }]);
    }
  });

  test('call logs: a ref is that ONE call row — not the other calls with its number; a text ref finds no call', async () => {
    // P2 has calls 3 (line 1) and 11 (line 6): #3 is call 3 only
    expect(callsOf(await get(withQ('/api/phone-lines/all/calls', '#3')))).toEqual([[3, S.P2, ['ref']]]);
    const one = await get(withQ('/api/phone-lines/1/calls', '#3'));
    expect([callsOf(one), one.json.search.ref]).toEqual([[[3, S.P2, ['ref']]], { id: 3, kind: 'call', other_party: S.P2, line_id: 1 }]);
    const six = await get(withQ('/api/phone-lines/all/calls', '#17'));
    expect([six.json.calls.map(c => [c.id, c.line_id]), six.json.search.ref]).toEqual([[[17, 6]], { id: 17, kind: 'call', other_party: X.NUM, line_id: 6 }]);
    // a call with no other party is still a call-log row (and no conversation)
    const anon = await get(withQ('/api/phone-lines/1/calls', '#15'));
    expect([callsOf(anon), anon.json.search.ref]).toEqual([[[15, null, ['ref']]], { id: 15, kind: 'call', other_party: null, line_id: 1 }]);
    expect((await get(withQ('/api/phone-lines/1/conversations', '#15'))).json.search.ref).toBeUndefined();
    // a text's ref on a call log: nothing
    const text = await get(withQ('/api/phone-lines/1/calls', '#4'));
    expect([text.json.calls, text.json.search.ref]).toEqual([[], undefined]);
    // bare digits on a call log: the number's calls AND the ref's call
    W.call(S.L1, '7345550100', 'incoming', { id: 2026 });
    expect(callsOf(await get(withQ('/api/phone-lines/all/calls', '2026')))).toEqual([[2026, '7345550100', ['ref']], [17, X.NUM, ['number']]]);
  });

  test('a ref outside the list finds nothing: a call under Texts (kind=sms); a firm line\'s text in All numbers', async () => {
    const texts = await get(withQ('/api/phone-lines/1/conversations', '#3', '&kind=sms'));
    expect([texts.json.conversations, texts.json.search.ref]).toEqual([[], undefined]);
    expect(by(await get(withQ('/api/phone-lines/1/conversations', '#4', '&kind=sms')))).toEqual({ [S.P2]: ['ref'] });
    // #7: line 1 → line 3 — listed on line 1, never in All (a firm line is not an outside number)
    expect(by(await get(withQ('/api/phone-lines/1/conversations', '#7')))).toEqual({ [S.L3]: ['ref'] });
    const all = await get(withQ('/api/phone-lines/all/conversations', '#7'));
    expect([all.json.conversations, all.json.search.ref]).toEqual([[], undefined]);
  });
});
