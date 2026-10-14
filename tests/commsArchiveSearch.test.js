/**
 * tests/commsArchiveSearch.test.js — the pure half of comms archive S6
 * (services/commsArchiveSearch.js): how a typed query becomes boolean-mode
 * terms, and how a snippet is cut. The SQL, the grants and the engine facts
 * are held to MySQL in tests/commsArchive.s6.mysql.test.js.
 */

'use strict';

const s = require('../services/commsArchiveSearch');

describe('tokenize', () => {
  test('words only: no operator, quote or punctuation survives; terms become +prefix*', () => {
    const t = s.tokenize(`+Bankrupt* -paystubs "filing" (x) ~y @z <a >b & | : ' OR 1=1 --`);
    expect(t.terms).toEqual(['bankrupt', 'paystubs', 'filing']);
    expect(t.against).toBe('+bankrupt* +paystubs* +filing*');
    expect(t.against).not.toMatch(/["()~@<>&|:-]/);
  });

  test('short words and InnoDB stopwords are ignored (and reported), duplicates collapse, case folds', () => {
    const t = s.tokenize('The trustee TRUSTEE meeting is on 26 about www bankruptcy');
    expect(t.terms).toEqual(['trustee', 'meeting', 'bankruptcy']);
    expect(t.ignored).toEqual(['the', 'is', 'on', '26', 'about', 'www']);
  });

  test('unicode letters and digits are words; underscores too; a case number splits on its dash', () => {
    expect(s.tokenize('Señora Müller 26-12345 snake_case').terms).toEqual(['señora', 'müller', '12345', 'snake_case']);
  });

  test('nothing usable → empty against; caps: 8 terms, 84 characters each', () => {
    expect(s.tokenize('to be or of').against).toBe('');
    expect(s.tokenize('').terms).toEqual([]);
    const many = s.tokenize(Array.from({ length: 12 }, (_, i) => `term${i}`).join(' '));
    expect(many.terms).toHaveLength(8);
    expect(s.tokenize('x'.repeat(100)).terms[0]).toHaveLength(84);
  });

  test('every InnoDB default stopword is in the list', () => {
    for (const w of ['a', 'about', 'an', 'are', 'as', 'at', 'be', 'by', 'com', 'de', 'en', 'for', 'from', 'how', 'i', 'in', 'is', 'it',
      'la', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'und', 'was', 'what', 'when', 'where', 'who', 'will', 'with', 'www']) {
      expect(s.STOPWORDS.has(w)).toBe(true);
    }
  });
});

describe('surrogate pairs (review A4)', () => {
  test('a clip or a term cap never splits an emoji / astral letter in half', () => {
    const e = '\u{1F600}';                                     // 2 code units
    const text = `${'a'.repeat(100)}${e}NEEDLE${e}${'b'.repeat(200)}`;
    for (let at = 95; at < 115; at++) {
      const c = s.clip(text, at);
      expect(c).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    expect(s.safeSlice(`ab${e}`, 0, 3)).toBe('ab');
    expect(s.safeSlice(`ab${e}cd`, 3, 6)).toBe(`${e}cd`);
    const t = s.tokenize(`${'x'.repeat(83)}\u{1D400}`).terms[0];       // MATHEMATICAL BOLD CAPITAL A is a letter
    expect(t).toBe('x'.repeat(83));
  });
});

describe('snippets', () => {
  test('firstHit finds a term only at the START of a word', () => {
    expect(s.firstHit('Rebank the bankruptcy', ['bank'])).toBe(11);
    expect(s.firstHit('nothing here', ['bank'])).toBe(-1);
  });

  test('clip keeps short text whole and cuts long text to a window around the hit', () => {
    expect(s.clip('short text', 2)).toBe('short text');
    const long = `${'a '.repeat(200)}NEEDLE${' b'.repeat(200)}`;
    const c = s.clip(long, long.indexOf('NEEDLE'));
    expect(c).toContain('NEEDLE');
    expect(c.length).toBeLessThanOrEqual(s.SNIPPET_CHARS + 2);
    expect(c.startsWith('…') && c.endsWith('…')).toBe(true);
  });

  test('snippetOf: the first segment holding a term, with its second; else summary; else the opening', () => {
    const row = { segments: [{ s: 'A', a: 0, b: 2, t: 'Hello' }, { s: 'B', a: 7.5, b: 9, t: 'about the trustee' }], summary_text: 'Asked for an adjournment.', full_text: 'Hello\nabout the trustee' };
    expect(s.snippetOf(row, ['trustee'])).toEqual({ snippet: 'about the trustee', snippet_at: 7.5, snippet_from: 'transcript' });
    expect(s.snippetOf(row, ['adjourn'])).toEqual({ snippet: 'Asked for an adjournment.', snippet_at: null, snippet_from: 'summary' });
    expect(s.snippetOf(row, ['zebra'])).toEqual({ snippet: 'Hello', snippet_at: 0, snippet_from: 'transcript' });
    expect(s.snippetOf({ segments: JSON.stringify(row.segments) }, ['trustee']).snippet_at).toBe(7.5);
  });
});
