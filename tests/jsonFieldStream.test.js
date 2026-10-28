/**
 * tests/jsonFieldStream.test.js
 *
 * lib/jsonFieldStream: the incremental extractor that turns Casey's streamed
 * answer JSON into prose for the pane. The streamed text is cosmetic (the
 * parsed JSON is authoritative), so the property that matters is: for every
 * way the bytes can be cut, the emitted text is exactly JSON.parse(full).answer
 * when "answer" is a root string key — and nothing at all otherwise.
 */

'use strict';

const { createFieldExtractor } = require('../lib/jsonFieldStream');

function run(chunks, field = 'answer') {
  const out = [];
  const x = createFieldExtractor({ field, onText: (t) => out.push(t) });
  for (const c of chunks) x.push(c);
  return out;
}
// Every 1..n-character cut of the text, plus single characters.
function everyCut(text) {
  const cuts = [[text], [...text]];
  for (const size of [2, 3, 5, 7, 11]) {
    const parts = [];
    for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
    cuts.push(parts);
  }
  for (let i = 1; i < text.length; i++) cuts.push([text.slice(0, i), text.slice(i)]);
  return cuts;
}

const SAMPLES = {
  plain: { answer: 'Three open matters have hearings next week.', citations: [] },
  escapes: { answer: 'Line 1\nLine 2\t"quoted" \\ back/slash \u0001 \b\f\r', citations: [{ query_id: 'q1' }] },
  unicode: { answer: 'Lévy — 😀 ünïcode 中文', suggestions: ['a'] },
  answerLast: { citations: [{ query_id: 'q1', row_number: 1, answer: 'nested decoy' }], action_draft: { answer: 'decoy 2', kind: 'task.create.v1' }, answer: 'The real answer.' },
  emptyAnswer: { answer: '', citations: [] },
  arraysFirst: { suggestions: ['answer', '"answer"'], destinations: [], answer: 'After arrays.' },
};

describe('emits exactly the parsed answer, however the text is cut', () => {
  for (const [name, obj] of Object.entries(SAMPLES)) {
    for (const [label, text] of [['compact', JSON.stringify(obj)], ['pretty', JSON.stringify(obj, null, 2)], ['ascii-escaped', JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)]]) {
      test(`${name} / ${label}`, () => {
        const want = JSON.parse(text).answer;
        for (const cut of everyCut(text)) expect(run(cut).join('')).toBe(want);
      });
    }
  }
});

describe('contract edges', () => {
  test('nothing before the answer value opens; the first emit is the first prose', () => {
    const out = [];
    const x = createFieldExtractor({ onText: (t) => out.push(t) });
    x.push('{"citations":[{"query_id":"q1"}],"ans');
    expect(out).toEqual([]);
    x.push('wer": "He');
    expect(out).toEqual(['He']);
    x.push('llo');
    expect(out).toEqual(['He', 'llo']);
  });

  test('a fenced reply (```json … ```) and leading prose are skipped', () => {
    expect(run(['Sure:\n```json\n{"answer":"ok"}\n```']).join('')).toBe('ok');
  });

  test('nested and non-root "answer" keys never emit', () => {
    expect(run(['{"action_draft":{"answer":"no"},"items":[{"answer":"no"}]}'])).toEqual([]);
  });

  test('a non-string answer emits nothing', () => {
    for (const v of ['null', '12', 'true', '{"x":"y"}', '["y"]']) expect(run([`{"answer":${v},"z":"q"}`])).toEqual([]);
  });

  test('a string VALUE that reads "answer" is not a key', () => {
    expect(run(['{"kind":"answer","x":"not this"}'])).toEqual([]);
  });

  test('only the first root answer streams (the parse keeps the last; the pane replaces)', () => {
    expect(run(['{"answer":"first","answer":"second"}']).join('')).toBe('first');
  });

  test('an escaped key name still matches, as JSON.parse would', () => {
    expect(run(['{"ans\\u0077er":"yes"}']).join('')).toBe('yes');
  });

  test('a surrogate pair split across chunks is emitted whole, never as a lone half', () => {
    const out = run(['{"answer":"a\\ud83d', '\\ude00b"}']);
    expect(out.join('')).toBe('a😀b');
    expect(out.some((t) => /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(t))).toBe(false);
  });

  test('invalid escapes and lone surrogates become U+FFFD, never a throw', () => {
    expect(run(['{"answer":"a\\qb\\uZZ12c\\ud83dd\\ude00e"}']).join('')).toBe('a\uFFFDb\uFFFDZ12c\uFFFDd\uFFFDe'); // the offending char after \u is consumed
  });

  test('everything after the root object closes is ignored', () => {
    expect(run(['{"x":1}{"answer":"late"}'])).toEqual([]);
  });

  test('reset() starts over for a retry attempt', () => {
    const out = [];
    const x = createFieldExtractor({ onText: (t) => out.push(t) });
    x.push('{"answer":"garb');
    x.reset();
    x.push('{"answer":"clean"}');
    expect(out.join('')).toBe('garbclean');
    expect(out[out.length - 1]).toBe('clean');
  });

  test('a throwing onText is swallowed', () => {
    const x = createFieldExtractor({ onText: () => { throw new Error('gone'); } });
    expect(() => x.push('{"answer":"x"}')).not.toThrow();
  });

  test('another field name works', () => {
    expect(run(['{"answer":"a","reason":"why"}'], 'reason').join('')).toBe('why');
  });

  test('onText is required', () => {
    expect(() => createFieldExtractor({})).toThrow(TypeError);
  });
});
