/**
 * tests/mailFtSearch.test.js — comms-polish-2 C1: the Comms Email tab's body
 * search. ftQueryOf turns a search box's text into InnoDB's boolean-mode query
 * (every searchable word required as a prefix), and scopeWhere's ?q= predicate
 * reaches the index only when there is such a query. The predicate itself runs
 * on MySQL in tests/mailboxS2.mysql.test.js (gated); here: the builder's rules
 * and the statement the list issues (the fake world's text match).
 * Run: npx jest tests/mailFtSearch.test.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mail-ft-test-secret';
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString('base64');

const svc = require('../services/mailbox/mailReadService');
const { makeWorld } = require('./helpers/mailboxS2World');

describe('ftQueryOf', () => {
  test('words of 3+ letters/digits, lower-cased, each a required prefix; stopwords, short words, repeats and boolean operators never reach the engine', () => {
    expect(svc.ftQueryOf('Paystub, October 2026 — the PDF')).toBe('+paystub* +october* +2026* +pdf*');
    expect(svc.ftQueryOf('ab in the')).toBe('');                         // nothing searchable → the LIKE-only predicate
    expect(svc.ftQueryOf('+evil* -x (y) "z" @w~')).toBe('+evil*');        // operators are not words
    expect(svc.ftQueryOf('Order order ORDER')).toBe('+order*');
    expect(svc.ftQueryOf('')).toBe('');
    expect(svc.ftQueryOf(null)).toBe('');
    expect(svc.ftQueryOf('ünïcode wörds')).toBe('+ünïcode* +wörds*');
    expect(svc.ftQueryOf('Paystub_October.pdf')).toBe('+paystub_october* +pdf*');   // '_' is a word character to InnoDB; '.' is not
  });
  test('at most FT_MAX_WORDS words (a pasted paragraph is not a search)', () => {
    const q = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(svc.ftQueryOf(q).split(' ')).toHaveLength(svc.FT_MAX_WORDS);
  });
  test('the stopword list is InnoDB\'s default (the words the index never holds)', () => {
    for (const w of ['the', 'and'.slice(0, 0) || 'this', 'with', 'from', 'www', 'com']) expect(svc.FT_STOPWORDS.has(w)).toBe(true);
    expect(svc.FT_MIN_TOKEN).toBe(3);
  });
});

describe('the list predicate', () => {
  test('with a searchable q the statement names MATCH(subject, body_text) with the boolean query; without one it is the From / Subject LIKE alone', async () => {
    const W = makeWorld();
    W.user(5); W.mailbox(1); W.grant(5, 1, { read: 1 });
    W.message(101, { subject: 'Plan objection', body_text: 'please find my paystub attached' });
    W.message(102, { subject: 'Lunch', body_text: 'nothing to see' });
    const sqls = () => W.statements.filter((s) => /FROM mail_messages m FORCE INDEX/.test(s.sql)).map((s) => s.sql);   // the list walk itself
    const a = await svc.listMessages(W.db, 5, { q: 'paystub' });
    expect(a.messages.map((m) => m.id)).toEqual([101]);                 // found by the BODY alone
    expect(sqls().pop()).toContain("MATCH(m.subject, m.body_text) AGAINST (? IN BOOLEAN MODE)");
    const prm = W.statements.filter((x) => /FROM mail_messages m FORCE INDEX/.test(x.sql)).pop().params;
    expect(prm.join('|')).toContain('%paystub%|%paystub%|+paystub*');   // the LIKEs then the boolean query, in the branch's params
    const b = await svc.listMessages(W.db, 5, { q: 'attached objection' });
    expect(b.messages.map((m) => m.id)).toEqual([101]);                 // every word, across subject AND body
    const c = await svc.listMessages(W.db, 5, { q: 'attached zzz' });
    expect(c.messages.map((m) => m.id)).toEqual([]);
    const d = await svc.listMessages(W.db, 5, { q: 'Lu' });
    expect(d.messages.map((m) => m.id)).toEqual([102]);                 // a 2-letter q: the substring LIKE, no MATCH
    expect(sqls().pop()).not.toContain('MATCH(');
  });
});
