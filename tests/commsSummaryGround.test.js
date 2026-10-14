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
    expect(Object.keys(r.summary)).toEqual(['call_type', 'summary', 'parties', 'commitments', 'dates',
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
  test('a voicemail is always call_type voicemail, whatever the model said', () => {
    expect(run(base({ call_type: 'client' }), { kind: 'voicemail' }).summary.call_type).toBe('voicemail');
    expect(run(base({ call_type: 'nonsense' }), { kind: 'voicemail' }).ok).toBe(true);
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
