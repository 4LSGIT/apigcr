/**
 * tests/phoneConsent.classify.test.js — YisraMail P2 (ref/YISRAMAIL_DESIGN.md §4.6)
 *
 * The pure keyword classifier of services/phoneConsentService.js: every
 * keyword, case / punctuation / emoji variants, the provider split for
 * SUBSCRIBE / RESUME / CONTINUE, every review phrase AND a near-miss per
 * phrase (live: 166 inbound texts contain "stop" as a substring), the
 * "STOP PLEASE" courtesy rule, and the gates handleInbound applies before any
 * write (firm-to-firm and non-10-digit senders never review). Nothing is
 * mocked; handleInbound's review gate runs on a db that records statements and
 * fails every one (a gate that queries anything fails the test).
 */
'use strict';

const svc = require('../services/phoneConsentService');
const { classify, classifyDetail, normalizeBody } = svc;

describe('normalizeBody', () => {
  test.each([
    ['  STOP  ', 'stop'],
    ['Stop.', 'stop'],
    ['STOP!!', 'stop'],
    ['stop 🛑', 'stop'],
    ['Opt-Out', 'opt out'],
    ['OPT_OUT', 'opt out'],
    ["Don't text me", 'dont text me'],
    ['Don’t   text\nme', 'dont text me'],
    ['', ''],
    [null, ''],
  ])('%j → %j', (input, out) => expect(normalizeBody(input)).toBe(out));
});

describe('keywords — exact single-message match', () => {
  test.each(svc.OPT_OUT_WORDS.map((w) => [w]))('opt-out %s (both providers, any case/punctuation)', (w) => {
    for (const provider of ['ringcentral', 'quo', null]) {
      expect(classify(w, provider)).toBe('opt_out');
      expect(classify(`  ${w.toUpperCase()}!! `, provider)).toBe('opt_out');
      expect(classify(`${w[0].toUpperCase()}${w.slice(1)}.`, provider)).toBe('opt_out');
    }
  });

  test('the list is the ruled one (design §4.6 + STOP ALL)', () => {
    expect([...svc.OPT_OUT_WORDS].sort()).toEqual(['cancel', 'end', 'opt out', 'optout', 'quit', 'revoke', 'stop', 'stop all', 'stopall', 'unsubscribe']);
    expect([...svc.OPT_IN_WORDS].sort()).toEqual(['start', 'unstop']);
    expect([...svc.OPT_IN_RC_ONLY_WORDS].sort()).toEqual(['continue', 'resume', 'subscribe']);
    expect([...svc.QUO_CONFIRM_WORDS].sort()).toEqual(['opt out', 'optout', 'revoke']);
  });

  test.each([['STOP ALL'], ['stop-all'], ['Opt out'], ['OPT-OUT'], ['optout'], ['Stop.'], ['STOP!!'], ['  stop  ']])('variant %j → opt_out', (b) => {
    expect(classify(b, 'quo')).toBe('opt_out');
  });

  test.each([['start'], ['START'], ['Unstop!']])('opt-in %j on both providers', (b) => {
    expect(classify(b, 'ringcentral')).toBe('opt_in');
    expect(classify(b, 'quo')).toBe('opt_in');
  });

  test('YES is not an opt-in', () => {
    expect(classify('YES', 'ringcentral')).toBeNull();
    expect(classify('yes', 'quo')).toBeNull();
  });

  test.each([['SUBSCRIBE'], ['Resume'], ['continue.']])('%j: opt-in on RingCentral, review on Quo (Quo keeps blocking)', (b) => {
    expect(classify(b, 'ringcentral')).toBe('opt_in');
    expect(classifyDetail(b, 'quo')).toMatchObject({ kind: 'review', reason: 'quo_optin_word' });
  });

  test('a keyword inside a longer message is not a keyword', () => {
    expect(classify('please stop', 'ringcentral')).not.toBe('opt_out');
    expect(classify('start the case', 'ringcentral')).toBeNull();
    expect(classify('end of month', 'quo')).toBeNull();
    expect(classify('I want to cancel my appointment', 'quo')).toBeNull();
  });

  test('empty / whitespace / emoji-only bodies are nothing', () => {
    for (const b of ['', '   ', '🛑', '!!!', null, undefined]) expect(classify(b, 'quo')).toBeNull();
  });
});

describe('review phrases — word-bounded, one test and one near-miss each', () => {
  const CASES = [
    ['stop texting', 'Please stop texting me', 'nonstop texting all day'],
    ['stop messaging', 'can you stop messaging me', 'nonstop messaging'],
    ['stop sending', 'STOP SENDING ME THESE', 'nonstop sending'],
    ["don't text", "Don't text this number", 'I dont textile'],
    ['do not text', 'Do not text me again', 'do not texture'],
    ['no more texts', 'no more texts please', 'no more textsize'],
    ['remove me', 'Remove me from your list', 'remove meat from the fridge'],
    ['take me off', 'take me off this list', 'take me offline'],
    ['unsubscribe me', 'unsubscribe me', 'unsubscribe meeting'],
    ['wrong number', 'wrong number', 'wrong numbers are annoying'],
    ['leave me alone', 'LEAVE ME ALONE!!', 'leave me alonely'],
  ];

  test('every listed phrase has a case below', () => {
    expect(CASES.map((c) => c[0]).sort()).toEqual([...svc.REVIEW_PHRASES].sort());
  });

  test.each(CASES)('%s: hit %j, near-miss %j', (phrase, hit, miss) => {
    expect(classifyDetail(hit, 'ringcentral')).toMatchObject({ kind: 'review', reason: 'phrase', keyword: normalizeBody(phrase) });
    expect(classify(miss, 'ringcentral')).toBeNull();
  });

  test('"stop" as a substring of ordinary messages never matches', () => {
    for (const b of ['the stop sign is broken', 'can you stop by the office tomorrow?', 'I stopped by', 'nonstop calls',
      'Reply STOP to opt out', 'Text STOP to unsubscribe from these alerts', 'stop the foreclosure', 'You have successfully unsubscribed']) {
      expect(classify(b, 'ringcentral')).toBeNull();
    }
  });

  test('"STOP PLEASE" (the documented Quo miss) and kin → review; "cancel it" / "end it" do not', () => {
    for (const b of ['STOP PLEASE', 'please stop', 'stop it', 'Stop now please', 'unsubscribe please', 'opt out please', 'quit it']) {
      expect(classifyDetail(b, 'quo')).toMatchObject({ kind: 'review', reason: 'courtesy' });
    }
    for (const b of ['cancel it', 'end it', 'cancel please', 'stop stop', 'please', 'stop the car please']) {
      expect(classify(b, 'quo')).toBeNull();
    }
  });
});

describe('handleInbound gates (before any statement)', () => {
  function failingDb() {
    const seen = [];
    return { seen, query: async (sql) => { seen.push(sql); throw new Error(`no statement expected: ${sql}`); }, getConnection: async () => { throw new Error('no transaction expected'); } };
  }

  test('an ordinary text → { kind: null }, no statement', async () => {
    const db = failingDb();
    expect(await svc.handleInbound(db, { provider: 'quo', providerRef: 'AC1', from10: '3135550001', body: 'see you at 3', firmToFirm: false }))
      .toEqual({ kind: null, recorded: false });
    expect(db.seen).toEqual([]);
  });

  test('firm-to-firm never reviews', async () => {
    const db = failingDb();
    const r = await svc.handleInbound(db, { provider: 'ringcentral', providerRef: '1', from10: '2486213656', line: '2485592400', body: 'wrong number', firmToFirm: true });
    expect(r).toEqual({ kind: 'review', recorded: false, reason: 'firm_line' });
    expect(db.seen).toEqual([]);
  });

  test('a sender that is not 10 digits (short code) records nothing', async () => {
    const db = failingDb();
    for (const from10 of ['72345', '', null]) {
      const r = await svc.handleInbound(db, { provider: 'ringcentral', providerRef: '1', from10, body: 'STOP', firmToFirm: false });
      expect(r).toEqual({ kind: 'opt_out', recorded: false, reason: 'sender_not_10_digit' });
    }
    expect(db.seen).toEqual([]);
  });
});
