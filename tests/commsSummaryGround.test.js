// tests/commsSummaryGround.test.js
//
// Comms archive S3 — the strict schema validation + grounding check
// (services/commsSummaryGround.js). Pure module, real inputs: no stand-ins.

'use strict';

const g = require('../services/commsSummaryGround');

const SEGS = [
  { s: 'A', a: 0, b: 4.2, t: 'Good morning, law office of Sandweiss.' },
  { s: 'B', a: 4.5, b: 12, t: 'Hi, this is Maria Lopez — I’m calling about my Chapter 13 case.' },
  { s: 'A', a: 12.4, b: 20, t: 'Sure. Can you send us your last two pay stubs by Friday?' },
  { s: 'B', a: 20.5, b: 30, t: 'Yes, I will email them. The trustee payment is $412 a month, right?' },
  { s: 'A', a: 30.2, b: 40, t: 'Correct. Your hearing is on November 3rd at 9 a.m.' },
];
const FULL = SEGS.map(s => s.t).join('\n');
const base = (o = {}) => ({
  call_type: 'client',
  summary: 'Client called about her Chapter 13 case; the firm asked for pay stubs.',
  parties: [{ speaker: 'A', role: 'firm', name: null }, { speaker: 'B', role: 'client', name: 'Maria Lopez' }],
  commitments: [{ by: 'other', what: 'email pay stubs', quote: 'I will email them' }],
  dates: [{ what: 'hearing', date_text: 'November 3rd at 9 a.m.', quote: 'Your hearing is on November 3rd at 9 a.m.' }],
  documents_requested: [{ what: 'last two pay stubs', quote: 'send us your last two pay stubs by Friday' }],
  amounts: [{ what: 'trustee payment', amount_text: '$412 a month', quote: 'The trustee payment is $412 a month' }],
  case_refs: [{ text: 'Chapter 13', quote: 'my Chapter 13 case' }],
  follow_up: { needed: true, why: 'Watch for the pay stubs.' },
  flags: [],
  ...o,
});
const run = (json, o = {}) => g.validate(json, { segments: SEGS, fullText: FULL, kind: 'call_recording', ...o });

describe('a well-grounded summary', () => {
  test('passes whole; t is the START of the segment the quote begins in, never the model\'s', () => {
    const r = run(base({ dates: [{ what: 'hearing', date_text: 'November 3rd', quote: 'hearing is on November 3rd', t: 999 }] }));
    expect(r.ok).toBe(true);
    expect(r.dropped).toBe(0);
    expect(r.summaryText).toBe('Client called about her Chapter 13 case; the firm asked for pay stubs.');
    expect(r.summary.dates[0].t).toBe(30.2);
    expect(r.summary.commitments[0]).toEqual({ by: 'other', what: 'email pay stubs', quote: 'I will email them', t: 20.5 });
    expect(r.summary.documents_requested[0].t).toBe(12.4);
    expect(r.summary.amounts[0].t).toBe(20.5);
    expect(r.summary.case_refs[0]).toEqual({ text: 'Chapter 13', quote: 'my Chapter 13 case' });   // no t
    expect(Object.keys(r.summary)).toEqual(['call_type', 'reached_voicemail', 'summary', 'parties', 'commitments', 'dates',
      'documents_requested', 'amounts', 'case_refs', 'follow_up', 'flags']);
  });

  test('normalisation: case, curly vs straight quotes, dashes, whitespace, wrapping quote marks, NFKC, zero-width', () => {
    const r = run(base({ case_refs: [{ text: 'chapter 13', quote: '"I\'m   CALLING about my chapter 13 case"' }] }));
    expect(r.summary.case_refs.length).toBe(1);
    const dash = run(base({ documents_requested: [{ what: 'intro', quote: 'Maria Lopez - I’m calling' }] }));
    expect(dash.summary.documents_requested.length).toBe(1);
    const odd = run(base({ documents_requested: [{ what: 'stubs', quote: 'two​ pay ｓtubs by Friday' }] }));   // zero-width + fullwidth s
    expect(odd.summary.documents_requested.length).toBe(1);
  });

  test('a quote starting EXACTLY at a segment\'s first word maps to that segment, not the one before', () => {
    const r = run(base({ case_refs: [], documents_requested: [{ what: 'intro', quote: 'Hi, this is Maria Lopez' }] }));
    expect(r.summary.documents_requested[0].t).toBe(4.5);
    const first = run(base({ documents_requested: [{ what: 'greeting', quote: 'Good morning, law office' }] }));
    expect(first.summary.documents_requested[0].t).toBe(0);
  });

  test('a quote spanning two segments maps to the first one', () => {
    const r = run(base({ documents_requested: [{ what: 'stubs', quote: 'by Friday? Yes, I will email them' }] }));
    expect(r.summary.documents_requested[0].t).toBe(12.4);
  });
});

describe('grounding drops — counted, never repaired', () => {
  test.each([
    ['a paraphrased quote', { commitments: [{ by: 'other', what: 'x', quote: 'she will send the stubs' }] }],
    ['an invented amount', { amounts: [{ what: 'fee', amount_text: '$900', quote: 'the fee is $900' }] }],
    ['an empty quote', { dates: [{ what: 'x', date_text: 'y', quote: '' }] }],
    ['a two-letter quote', { dates: [{ what: 'x', date_text: 'y', quote: 'on' }] }],
    ['a missing quote', { documents_requested: [{ what: 'stubs' }] }],
    ['a bad "by"', { commitments: [{ by: 'client', what: 'x', quote: 'I will email them' }] }],
    ['a missing date_text', { dates: [{ what: 'x', quote: 'Your hearing is on November 3rd' }] }],
    ['a non-object item', { amounts: ['$412'] }],
    ['an over-long what', { documents_requested: [{ what: 'x'.repeat(301), quote: 'pay stubs' }] }],
    ['a party with an unknown speaker', { parties: [{ speaker: 'C', role: 'other', name: null }] }],
    ['a party with a bad role', { parties: [{ speaker: 'A', role: 'judge', name: null }] }],
  ])('%s', (_n, over) => {
    const r = run(base(over));
    expect(r.ok).toBe(true);
    expect(r.dropped).toBe(1);
  });

  test('a name not said on the call becomes null; the known contact\'s name survives', () => {
    const r = run(base({ parties: [{ speaker: 'B', role: 'client', name: 'Jane Doe' }] }));
    expect(r.summary.parties[0].name).toBeNull();
    const k = run(base({ parties: [{ speaker: 'B', role: 'client', name: 'Maria L. Lopez' }] }), { knownNames: ['Maria L. Lopez'] });
    expect(k.summary.parties[0].name).toBe('Maria L. Lopez');
  });

  test('flags keep only the known ones; unknown top-level keys are dropped', () => {
    const r = run(base({ flags: ['personal', 'urgent', 'personal'], extra_key: 'x' }));
    expect(r.summary.flags).toEqual(['personal']);
    expect(r.summary.extra_key).toBeUndefined();
  });

  test('missing lists are empty lists; missing follow_up is "not needed"', () => {
    const r = run({ call_type: 'spam', summary: 'A robocall.' });
    expect(r).toMatchObject({ ok: true, dropped: 0 });
    expect(r.summary).toMatchObject({ parties: [], commitments: [], dates: [], follow_up: { needed: false, why: '' }, flags: [] });
  });
});

describe('the review\'s hardening cases (2026-10-15)', () => {
  const SEG2 = [
    { s: 'A', a: 0, b: 5, t: 'We need the W-2, and the last pay stub.' },
    { s: 'B', a: 5, b: 9, t: 'I can pay 500 a month. See you tomorrow.' },
    { s: 'A', a: 9, b: 12, t: 'Tom will call the trustee.' },
    { s: 'B', a: 12, b: 15, t: 'I will send the documents.' },
    { s: 'A', a: 15, b: 18, t: 'We will file the motion.' },
  ];
  const v2 = (o) => g.validate({ call_type: 'client', summary: 'x', ...o }, { segments: SEG2, fullText: SEG2.map(x => x.t).join('\n') });

  test('"$50,000" quoting "the": dropped (min words AND the amount must be inside its quote)', () => {
    expect(v2({ amounts: [{ what: 'debt', amount_text: '$50,000', quote: 'the' }] }).dropped).toBe(1);
    expect(v2({ amounts: [{ what: 'debt', amount_text: '$50,000', quote: 'We need the W-2' }] }).dropped).toBe(1);
  });

  test('"pay 50" does not ground in "pay 500" (word boundaries)', () => {
    expect(v2({ amounts: [{ what: 'plan', amount_text: '$50', quote: 'I can pay 50' }] }).dropped).toBe(1);
    expect(v2({ amounts: [{ what: 'plan', amount_text: '$500', quote: 'I can pay 500 a month' }] }).summary.amounts.length).toBe(1);
  });

  test('"Tom" is a name in "Tom will call", not in "tomorrow"', () => {
    const only = (segs) => g.validate({ call_type: 'client', summary: 'x', parties: [{ speaker: 'B', role: 'client', name: 'Tom' }] },
      { segments: segs, fullText: '' }).summary.parties[0].name;
    expect(only([SEG2[1]])).toBeNull();
    expect(only(SEG2)).toBe('Tom');
  });

  test('a commitment spliced across a speaker change is dropped; one speaker over two segments is kept', () => {
    expect(v2({ commitments: [{ by: 'other', what: 'send docs', quote: 'call the trustee. I will send the documents' }] }).dropped).toBe(1);
    const SAME = [{ s: 'B', a: 0, b: 2, t: 'I will send' }, { s: 'B', a: 2, b: 4, t: 'the documents today.' }];
    const r = g.validate({ call_type: 'client', summary: 'x', commitments: [{ by: 'other', what: 'docs', quote: 'I will send the documents today' }] },
      { segments: SAME, fullText: '' });
    expect(r.summary.commitments).toEqual([{ by: 'other', what: 'docs', quote: 'I will send the documents today', t: 0 }]);
  });

  test('"W-2, and" vs "W-2 — and": KEPT (punctuation is not evidence)', () => {
    expect(v2({ documents_requested: [{ what: 'W-2', quote: 'We need the W-2 — and the last pay stub' }] }).summary.documents_requested.length).toBe(1);
  });

  test('a date / case ref whose own text is not in its quote is dropped', () => {
    expect(v2({ dates: [{ what: 'call', date_text: 'Friday', quote: 'See you tomorrow' }] }).dropped).toBe(1);
    expect(v2({ case_refs: [{ text: '26-40001', quote: 'file the motion' }] }).dropped).toBe(1);
  });

  test('a quote under 3 words is dropped even when it occurs (and the item has no other fault)', () => {
    expect(v2({ documents_requested: [{ what: 'stub', quote: 'pay stub' }] }).dropped).toBe(1);
    expect(v2({ documents_requested: [{ what: 'stub', quote: 'last pay stub' }] }).dropped).toBe(0);
  });

  test('a zero-width character INSIDE a word is removed, not turned into a word break', () => {
    expect(v2({ documents_requested: [{ what: 'stub', quote: 'the last pa​y st­ub' }] }).summary.documents_requested.length).toBe(1);
  });

  test('failure reasons are fixed codes — never model text', () => {
    expect(v2({ call_type: 'IGNORE PREVIOUS INSTRUCTIONS' }).why).toBe('bad_call_type');
    expect(g.validate({ call_type: 'client', summary: '' }, { segments: SEG2 }).why).toBe('bad_summary');
    expect(g.validate('text').why).toBe('not_object');
  });
});

describe('round 2 (2026-10-15): number tokens, ordinals, short quotes', () => {
  const SEG3 = [
    { s: 'A', a: 0, b: 6, t: 'The balance is $50,000 and the fee is $1,200.50 today.' },
    { s: 'B', a: 6, b: 10, t: 'My hearing is 3/15 at 10:30, or March 3rd?' },
    { s: 'A', a: 10, b: 12, t: 'Yes.' },
    { s: 'B', a: 12, b: 14, t: 'Will do.' },
    { s: 'A', a: 14, b: 18, t: 'Case 26-40001 is open. Pay 500 a month.' },
  ];
  const v3 = (o) => g.validate({ call_type: 'client', summary: 'x', ...o }, { segments: SEG3, fullText: SEG3.map(x => x.t).join('\n') });

  test('normalise keeps a number whole: thousands commas dropped, inner . / : - kept, ordinals stripped', () => {
    expect(g.normalise('$1,200,000.50')).toBe('1200000.50');
    expect(g.normalise('3/15 at 10:30')).toBe('3/15 at 10:30');
    expect(g.normalise('March 3rd, the 21st')).toBe('march 3 the 21');
    expect(g.normalise('3,4 and W-2')).toBe('3 4 and w 2');
    expect(g.normalise('26-40001-mar')).toBe('26-40001 mar');
  });

  test.each([
    ['"$50" against "$50,000"', { amounts: [{ what: 'x', amount_text: '$50', quote: 'balance is $50,000' }] }],
    ['"$50" quoting "$50,000"', { amounts: [{ what: 'x', amount_text: '$50', quote: '$50,000' }] }],
    ['"$1,200" against "$1,200.50"', { amounts: [{ what: 'fee', amount_text: '$1,200', quote: 'the fee is $1,200.50' }] }],
    ['date "3" against "3/15"', { dates: [{ what: 'hearing', date_text: '3', quote: 'My hearing is 3/15' }] }],
    ['"Pay 50" against "Pay 500"', { amounts: [{ what: 'plan', amount_text: '50', quote: 'Pay 50' }] }],
  ])('dropped: %s', (_n, o) => {
    expect(v3(o).dropped).toBe(1);
  });

  test.each([
    ['"$1200.50" against "$1,200.50"', { amounts: [{ what: 'fee', amount_text: '$1200.50', quote: '$1,200.50' }] }, 'amounts'],
    ['"March 3" against "March 3rd"', { dates: [{ what: 'hearing', date_text: 'March 3', quote: 'March 3rd' }] }, 'dates'],
    ['a 1-word amount quote', { amounts: [{ what: 'balance', amount_text: '$50,000', quote: '$50,000' }] }, 'amounts'],
    ['a 2-word case ref', { case_refs: [{ text: '26-40001', quote: 'Case 26-40001' }] }, 'case_refs'],
    ['a whole-segment commitment "Will do."', { commitments: [{ by: 'other', what: 'agrees', quote: 'Will do.' }] }, 'commitments'],
    ['a whole-segment commitment "Yes."', { commitments: [{ by: 'firm', what: 'agrees', quote: 'Yes' }] }, 'commitments'],
  ])('kept: %s', (_n, o, key) => {
    const r = v3(o);
    expect(r.dropped).toBe(0);
    expect(r.summary[key].length).toBe(1);
  });

  test('a short commitment that is NOT a whole segment, or a short document request, is dropped', () => {
    expect(v3({ commitments: [{ by: 'other', what: 'x', quote: 'March 3' }] }).dropped).toBe(1);   // 2 words, part of a segment
    expect(v3({ commitments: [{ by: 'other', what: 'x', quote: 'My hearing' }] }).dropped).toBe(1); // 2 words at a segment's START, not the whole segment
    expect(v3({ documents_requested: [{ what: 'x', quote: 'Yes' }] }).dropped).toBe(1);             // whole segment, but not a commitment
  });
});

describe('wrong SHAPE fails the summary (the caller charges an attempt)', () => {
  test.each([
    ['not an object', 'text'],
    ['an array', []],
    ['bad call_type', base({ call_type: 'debtor' })],
    ['no summary', base({ summary: '' })],
    ['an over-long summary', base({ summary: 'x'.repeat(2001) })],
    ['parties not an array', base({ parties: {} })],
    ['dates not an array', base({ dates: 'Nov 3' })],
    ['follow_up malformed', base({ follow_up: { needed: 'yes' } })],
    ['flags not an array', base({ flags: 'personal' })],
  ])('%s', (_n, json) => {
    expect(run(json).ok).toBe(false);
  });
});

describe('voicemail + no segments', () => {
  test('v3: a voicemail keeps the counterparty as call_type and is always reached_voicemail; a bad call_type still fails', () => {
    const r = run(base({ call_type: 'client', reached_voicemail: false }), { kind: 'voicemail' });
    expect(r.summary).toMatchObject({ call_type: 'client', reached_voicemail: true });
    expect(run(base({ call_type: 'nonsense' }), { kind: 'voicemail' })).toMatchObject({ ok: false, why: 'bad_call_type' });
  });
  test('with only full_text, quotes still ground; t is null', () => {
    const r = g.validate(base(), { segments: [], fullText: FULL, kind: 'call_recording' });
    expect(r.ok).toBe(true);
    expect(r.summary.dates[0].t).toBeNull();
    expect(r.summary.parties).toEqual([]);          // no speakers to anchor to
  });
});

describe('transcriptText', () => {
  test('"[mm:ss] S: words", h:mm:ss past an hour', () => {
    expect(g.transcriptText([{ s: 'A', a: 65.9, t: 'hi' }, { s: 'ch2', a: 3725, t: 'bye' }]))
      .toBe('[01:05] A: hi\n[1:02:05] ch2: bye');
    expect(g.transcriptText([], 'plain')).toBe('plain');
  });
});

describe('round 3 (2026-10-14): bare numbers, short commitments at their whole-segment occurrence', () => {
  const g = require('../services/commsSummaryGround');
  const SEG4 = [
    { s: 'A', a: 0, b: 5, t: "I'm 50 years old and I have 3 kids." },
    { s: 'B', a: 5, b: 9, t: 'So yes, I can send it.' },
    { s: 'B', a: 9, b: 10, t: 'Yes.' },
    { s: 'A', a: 10, b: 11, t: 'Will do.' },
    { s: 'C', a: 11, b: 12, t: 'Sure.' },
  ];
  const PARTIES = [{ speaker: 'A', role: 'firm', name: null }, { speaker: 'B', role: 'client', name: null }];
  const v4 = (o) => g.validate({ call_type: 'client', summary: 'x', parties: PARTIES, ...o }, { segments: SEG4, fullText: SEG4.map(x => x.t).join('\n') });

  test('a bare number with a 1-word quote grounds nothing: "$50" from "50", date "3" from "3"', () => {
    expect(v4({ amounts: [{ what: 'settlement', amount_text: '$50', quote: '50' }] }).dropped).toBe(1);
    expect(v4({ dates: [{ what: 'hearing', date_text: '3', quote: '3' }] }).dropped).toBe(1);
  });

  test('the same bare number with a 2-word quote is kept (the quote binds it)', () => {
    const r = v4({ amounts: [{ what: 'age', amount_text: '50', quote: '50 years' }] });
    expect(r.dropped).toBe(0);
    expect(r.summary.amounts[0].t).toBe(0);
  });

  test('a short commitment skips a mid-segment "yes" and is kept at the later whole-segment "Yes." (its t, its speaker)', () => {
    const r = v4({ commitments: [{ by: 'other', what: 'sends it', quote: 'Yes' }] });
    expect(r.dropped).toBe(0);
    expect(r.summary.commitments[0].t).toBe(9);
  });

  test('a firm "Will do." for a by:other commitment is dropped; for by:firm it is kept', () => {
    expect(v4({ commitments: [{ by: 'other', what: 'x', quote: 'Will do.' }] }).dropped).toBe(1);
    const r = v4({ commitments: [{ by: 'firm', what: 'x', quote: 'Will do.' }] });
    expect(r.dropped).toBe(0);
    expect(r.summary.commitments[0].t).toBe(10);
  });

  test('a client "Yes." for a by:firm commitment is dropped', () => {
    expect(v4({ commitments: [{ by: 'firm', what: 'x', quote: 'Yes' }] }).dropped).toBe(1);
  });

  test('a speaker with no role in parties[] cannot contradict `by`', () => {
    expect(v4({ commitments: [{ by: 'firm', what: 'x', quote: 'Sure.' }] }).dropped).toBe(0);
    expect(v4({ commitments: [{ by: 'other', what: 'x', quote: 'Sure.' }] }).dropped).toBe(0);
  });
});

describe('v3 (2026-10-15): call_type / reached_voicemail, resolved_date, the role check on EVERY commitment', () => {
  const vg = (o, opts = {}) => g.validate(base(o), { segments: SEGS, fullText: FULL, kind: 'call_recording', knownNames: [], ...opts });

  test('call_type is the counterparty: "voicemail" is COERCED to other + reached_voicemail (counted, never a failure); reached_voicemail is a boolean, false when missing', () => {
    const c = vg({ call_type: 'voicemail' });
    expect(c).toMatchObject({ ok: true, coerced: 'call_type', summary: { call_type: 'other', reached_voicemail: true } });
    expect(vg({ call_type: 'voicemail', reached_voicemail: false }).summary.reached_voicemail).toBe(true);
    expect(vg({}).coerced).toBeNull();
    expect(vg({ call_type: 'nonsense' })).toEqual({ ok: false, why: 'bad_call_type' });
    expect(vg({}).summary.reached_voicemail).toBe(false);
    expect(vg({ reached_voicemail: true }).summary).toMatchObject({ call_type: 'client', reached_voicemail: true });
    for (const bad of ['yes', 1, [], {}]) expect(vg({ reached_voicemail: bad })).toEqual({ ok: false, why: 'bad_reached_voicemail' });
    expect(g.CALL_TYPES.has('voicemail')).toBe(false);
  });

  test('resolved_date: a real date within [−400, +800] days of the call day survives; anything else is null and the item stays', () => {
    const d = (rd, callDay = '2026-10-15') => vg({ dates: [{ what: 'hearing', date_text: 'November 3rd at 9 a.m.', resolved_date: rd,
      quote: 'Your hearing is on November 3rd at 9 a.m.' }] }, { callDay });
    expect(d('2026-11-03').summary.dates[0]).toMatchObject({ date_text: 'November 3rd at 9 a.m.', resolved_date: '2026-11-03', t: 30.2 });
    expect(d('2025-09-10').summary.dates[0].resolved_date).toBe('2025-09-10');        // −400 days: the edge, kept
    expect(d('2028-12-23').summary.dates[0].resolved_date).toBe('2028-12-23');        // +800 days: the edge, kept
    for (const bad of ['2025-09-09', '2028-12-24', '2026-02-30', '2026-13-01', '11/03/2026', 'Monday', 20261103, null, undefined]) {
      const r = d(bad);
      expect([String(bad), r.ok, r.dropped, r.summary.dates.length, r.summary.dates[0].resolved_date]).toEqual([String(bad), true, 0, 1, null]);
    }
    expect(d('2026-11-03', null).summary.dates[0].resolved_date).toBeNull();          // no call day: nothing to check against
    expect(g.resolvedDate('2024-02-29', '2024-03-01')).toBe('2024-02-29');            // a real leap day
  });

  test('every commitment — not only a short one — is quoted from a speaker whose role agrees with `by`', () => {
    // the firm ASKED for the pay stubs; quoting that request as a FIRM commitment is the 2140 shape
    const askedAsFirm = vg({ commitments: [{ by: 'firm', what: 'send pay stubs', quote: 'send us your last two pay stubs by Friday' }] });
    expect([askedAsFirm.dropped, askedAsFirm.summary.commitments]).toEqual([0, [expect.objectContaining({ by: 'firm' })]]);   // speaker A is the firm: kept
    const clientAsFirm = vg({ commitments: [{ by: 'firm', what: 'email the stubs', quote: 'I will email them' }] });
    expect([clientAsFirm.dropped, clientAsFirm.summary.commitments]).toEqual([1, []]);                // B is the client: dropped
    const firmAsOther = vg({ commitments: [{ by: 'other', what: 'send stubs', quote: 'send us your last two pay stubs by Friday' }] });
    expect([firmAsOther.dropped, firmAsOther.summary.commitments]).toEqual([1, []]);
    const noRoles = vg({ parties: [], commitments: [{ by: 'firm', what: 'email the stubs', quote: 'I will email them' }] });
    expect(noRoles.dropped).toBe(0);                                                                  // no role: no objection
  });

  test('a phrase said by BOTH sides: each commitment is kept at the turn of the speaker whose role agrees with `by`, with that turn\'s t', () => {
    const SEG = [
      { s: 'B', a: 0, b: 5, t: 'I will email you the documents tonight.' },
      { s: 'A', a: 5, b: 9, t: 'Great, I will email you the documents tonight too, so we both have them.' },
      { s: 'B', a: 9, b: 11, t: 'Thanks.' },
    ];
    const P = [{ speaker: 'A', role: 'firm', name: null }, { speaker: 'B', role: 'client', name: null }];
    const v = (by) => g.validate({ call_type: 'client', summary: 'x', parties: P,
      commitments: [{ by, what: 'email the documents', quote: 'I will email you the documents tonight' }] },
    { segments: SEG, fullText: SEG.map(x => x.t).join('\n') });
    expect([v('firm').dropped, v('firm').summary.commitments[0].t]).toEqual([0, 5]);                 // the firm's turn, not the first
    expect([v('other').dropped, v('other').summary.commitments[0].t]).toEqual([0, 0]);
    const nobody = g.validate({ call_type: 'client', summary: 'x', parties: [{ speaker: 'A', role: 'client', name: null }, { speaker: 'B', role: 'client', name: null }],
      commitments: [{ by: 'firm', what: 'x', quote: 'I will email you the documents tonight' }] }, { segments: SEG, fullText: '' });
    expect(nobody.dropped).toBe(1);                                                                   // no firm turn says it
  });
});

describe('v4 self-address: a party whose OWN words greet its assigned name loses that name (flag only, never repaired)', () => {
  // The v3 QA's top fault, on the attorney's OUTGOING calls: the callee answers "Hey, Stuart." and the model makes
  // the callee Stuart. Synthetic transcripts only.
  const SWAP = [
    { s: 'A', a: 0, b: 1, t: 'Hey, Stuart.' },
    { s: 'B', a: 1, b: 3, t: 'Hi, it\'s Stuart. Do you know who it is?' },
    { s: 'A', a: 3, b: 6, t: 'Yes, Stuart Sandweiss. Send me the papers and I\'ll look at them.' },
    { s: 'B', a: 6, b: 8, t: 'I\'ll call you back tomorrow.' },
  ];
  const vs = (parties, segs) => g.validate({ call_type: 'client', summary: 'x', parties }, { segments: segs, fullText: segs.map(x => x.t).join('\n') });
  const named = (r, sp) => r.summary.parties.find(p => p.speaker === sp).name;

  test('"Hey, Stuart" from the party made Stuart: name nulled, speaker listed; the role is NOT repaired; nothing counted as dropped', () => {
    const r = vs([{ speaker: 'A', role: 'firm', name: 'Stuart' }, { speaker: 'B', role: 'client', name: null }], SWAP);
    expect(r.ok).toBe(true);
    expect(r.selfAddressed).toEqual(['A']);
    expect(r.summary.parties).toEqual([{ speaker: 'A', role: 'firm', name: null }, { speaker: 'B', role: 'client', name: null }]);
    expect(r.dropped).toBe(0);
  });

  test('the full name in reply ("Yes, Stuart Sandweiss." after "do you know who it is?") is an address, not the opening line', () => {
    const segs = [{ s: 'A', a: 0, b: 1, t: 'Hello?' }, ...SWAP.slice(1)];
    expect(vs([{ speaker: 'A', role: 'firm', name: 'Stuart Sandweiss' }], segs).selfAddressed).toEqual(['A']);
  });

  test('the correct assignment passes: "Hi, this is Stuart" / "Hi, it\'s Stuart" from Stuart is a self-introduction', () => {
    const r = vs([{ speaker: 'B', role: 'firm', name: 'Stuart' }, { speaker: 'A', role: 'client', name: null }], SWAP);
    expect([r.selfAddressed, named(r, 'B')]).toEqual([[], 'Stuart']);
    const intro = [{ s: 'A', a: 0, b: 1, t: 'Hello?' }, { s: 'B', a: 1, b: 3, t: 'Hi, this is Stuart from the law office.' }];
    expect(vs([{ speaker: 'B', role: 'firm', name: 'Stuart' }], intro).selfAddressed).toEqual([]);
  });

  test('the attorney\'s own opening line "Hello, Stuart Sandweiss." is a self-introduction — full name or first name assigned', () => {
    const segs = [{ s: 'A', a: 0, b: 1, t: 'Hello?' }, { s: 'B', a: 1, b: 3, t: 'Hello, Stuart Sandweiss.' }, { s: 'A', a: 3, b: 5, t: 'Oh hi.' }];
    expect(vs([{ speaker: 'B', role: 'firm', name: 'Stuart Sandweiss' }], segs).selfAddressed).toEqual([]);
    expect(vs([{ speaker: 'B', role: 'firm', name: 'Stuart' }], segs).selfAddressed).toEqual([]);
    // …but a first name ENDING the greeting in the opening line is an address ("Hey, Stuart. How are you?")
    const greet = [{ s: 'A', a: 0, b: 1, t: 'Hey, Stuart. How are you?' }];
    expect(vs([{ speaker: 'A', role: 'firm', name: 'Stuart' }], greet).selfAddressed).toEqual(['A']);
  });

  test('"Thanks, Stuart" from the OTHER party flags nothing — only a party\'s own assigned name counts', () => {
    const segs = [
      { s: 'A', a: 0, b: 2, t: 'Sandweiss law, Stuart speaking.' },
      { s: 'B', a: 2, b: 5, t: 'Thanks so much, Stuart, for the help.' },
    ];
    const r = vs([{ speaker: 'A', role: 'firm', name: 'Stuart' }, { speaker: 'B', role: 'client', name: null }], segs);
    expect([r.selfAddressed, named(r, 'A')]).toEqual([[], 'Stuart']);
    // the same words, the parties swapped by the model → B (made Stuart) thanks Stuart: flagged
    const s = vs([{ speaker: 'B', role: 'firm', name: 'Stuart' }, { speaker: 'A', role: 'client', name: null }], segs);
    expect(s.selfAddressed).toEqual(['B']);
  });

  test('self-tails ("Stuart here", "Stuart calling") are introductions; "bye Mr. Sandweiss" is an address; a last name needs a title', () => {
    // the name rides as a KNOWN name (it is not said whole here), so it survives grounding and only the self-address check decides
    const one = (t) => {
      const segs = [{ s: 'B', a: 0, b: 1, t: 'Hello?' }, { s: 'A', a: 1, b: 2, t: 'Okay.' }, { s: 'A', a: 2, b: 3, t }];
      const r = g.validate({ call_type: 'client', summary: 'x', parties: [{ speaker: 'A', role: 'firm', name: 'Stuart Sandweiss' }] },
        { segments: segs, fullText: '', knownNames: ['Stuart Sandweiss'] });
      expect(r.summary.parties[0].name).toBe(r.selfAddressed.length ? null : 'Stuart Sandweiss');
      return r.selfAddressed;
    };
    expect(one('Hi, Stuart here.')).toEqual([]);
    expect(one('Hey, Stuart calling about the case.')).toEqual([]);
    expect(one('Okay, bye Mr. Sandweiss.')).toEqual(['A']);
    expect(one('Thanks, Sandweiss law.')).toEqual([]);
    expect(one('Good morning, Sandweiss Law.')).toEqual([]);                    // the firm's own greeting: a surname with no title
    expect(one('Hey, Stuart, calling about the case.')).toEqual([]);            // a self-tail after punctuation
    expect(one('Hi, Stuartson.')).toEqual([]);                                   // whole words only
  });

  test('the name absent from the call: nothing to check, nothing flagged; a known contact name that is never greeted survives', () => {
    const segs = [{ s: 'A', a: 0, b: 2, t: 'Hello, how can I help?' }, { s: 'B', a: 2, b: 5, t: 'I have a question about my case.' }];
    const r = g.validate({ call_type: 'client', summary: 'x', parties: [{ speaker: 'A', role: 'firm', name: 'Stuart' },
      { speaker: 'B', role: 'client', name: 'Maria Lopez' }] }, { segments: segs, fullText: '', knownNames: ['Maria Lopez'] });
    expect(r.selfAddressed).toEqual([]);
    expect(r.summary.parties.map(p => p.name)).toEqual([null, 'Maria Lopez']);    // Stuart: not said → null by grounding, not flagged
  });

  test('the base fixture ("Hi, this is Maria Lopez") is untouched', () => {
    expect(run(base()).selfAddressed).toEqual([]);
    expect(run(base()).summary.parties[1].name).toBe('Maria Lopez');
  });
});

describe('v4: a vendor-masked word in a quote (first letter + asterisks) grounds like any other word', () => {
  test('a commitment quoting a masked word is kept, with its t', () => {
    const segs = [{ s: 'A', a: 0, b: 2, t: 'Hello?' }, { s: 'B', a: 2, b: 6, t: 'I will send the f*** papers tomorrow, I promise.' }];
    const r = g.validate({ call_type: 'client', summary: 'x', parties: [{ speaker: 'B', role: 'firm', name: null }],
      commitments: [{ by: 'firm', what: 'send the papers', quote: 'I will send the f*** papers tomorrow' }] },
    { segments: segs, fullText: segs.map(x => x.t).join('\n') });
    expect([r.dropped, r.summary.commitments.length, r.summary.commitments[0].t]).toEqual([0, 1, 2]);
  });
});

describe('v4 self-address, read on the raw words: common words, sentence breaks, greetings vs replies with a full name', () => {
  const flagged = (name, lines, knownNames = []) => g.validate({ call_type: 'client', summary: 'x', parties: [{ speaker: 'A', role: 'firm', name }] },
    { segments: lines.map((t, i) => ({ s: 'A', a: i, b: i + 1, t })), fullText: '', knownNames }).selfAddressed;

  test('a common word is no name: "Yes, will do." (Will), "Thanks, Mark it down." (Mark) — the capitalised address still is', () => {
    expect(flagged('Will', ['Okay.', 'Yes, will do.'])).toEqual([]);
    expect(flagged('Will', ['Okay.', 'Yes, will, as soon as it comes in.'])).toEqual([]);   // lowercase: not a name
    expect(flagged('Will', ['Okay.', 'Thanks, Will.'])).toEqual(['A']);
    expect(flagged('Mark', ['Okay.', 'Thanks, Mark it down.'])).toEqual([]);
    expect(flagged('Mark', ['Okay.', 'Thanks. Mark it down.'])).toEqual([]);        // a sentence break ends the greeting
    expect(flagged('Mark', ['Okay.', 'Thanks, Mark.'])).toEqual(['A']);
  });

  test('a GREETING + the full name is a self-introduction in any segment: a split pickup, a voicemail line', () => {
    expect(flagged('Stuart Sandweiss', ['Hello.', 'Hello, Stuart Sandweiss.'])).toEqual([]);
    expect(flagged('Stuart', ['Hello.', 'Hello, Stuart Sandweiss.'], ['Stuart'])).toEqual([]);   // surname unassigned: a run-on capital
    expect(flagged('Stuart Sandweiss', ['Hi, it is me.', 'Hi, Stuart Sandweiss again, about the hearing.'])).toEqual([]);
  });

  test('a REPLY + the full name is an address after the opening line, and not in it', () => {
    expect(flagged('Stuart Sandweiss', ['Okay.', 'Thanks, Stuart Sandweiss.'])).toEqual(['A']);
    expect(flagged('Stuart Sandweiss', ['Thanks, Stuart Sandweiss.'])).toEqual([]);
    expect(flagged('Stuart', ['Okay.', 'Yes, Stuart Sandweiss.'], ['Stuart'])).toEqual(['A']);
  });
});

describe('v4 self-address: a sentence break ends the greeting', () => {
  test('"Yes. Will, the trustee, called." mentions Will; it does not address him', () => {
    const r = g.validate({ call_type: 'client', summary: 'x', parties: [{ speaker: 'A', role: 'firm', name: 'Will' }] },
      { segments: [{ s: 'A', a: 0, b: 1, t: 'Okay.' }, { s: 'A', a: 1, b: 3, t: 'Yes. Will, the trustee, called.' }], fullText: '' });
    expect(r.selfAddressed).toEqual([]);
  });
});
