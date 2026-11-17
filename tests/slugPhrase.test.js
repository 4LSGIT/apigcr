/**
 * public/js/slugPhrase.js + the Redirects Randomize button (public/redirects.html).
 *
 * Rule (Fred, 2026-11-17): Randomize appends random words to what is typed
 * until the slug has five parts (typed parts count), never fewer than three
 * random words, never past 64 chars; a prefix too long for three is refused.
 * A second press on an untouched result re-rolls on the same prefix.
 * Words: crypto.getRandomValues, rejection-sampled; the list is hand-curated.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const P = require('../public/js/slugPhrase.js');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'redirects.html'), 'utf8');

const WORD = '[a-z]{3,6}';
const tail = (n, sep = '-') => new RegExp(`${WORD}(?:${sep}${WORD}){${n - 1}}$`);
const words = (v, prefix) => v.slice(prefix.length).split(/[-_]/);

// A fill that always draws the LONGEST word (worst case for the length budget).
function longestFill() {
  const i = P.WORDS.findIndex((w) => w.length === P.WORD_MAX);
  return (buf) => { buf[0] = i; return buf; };
}

describe('the word list', () => {
  test('≥ 1,300 unique lowercase words of 3–6 letters, sorted for review; WORD_MAX is the longest', () => {
    expect(P.WORDS.length).toBeGreaterThanOrEqual(1300);
    expect(new Set(P.WORDS).size).toBe(P.WORDS.length);
    for (const w of P.WORDS) expect(w).toMatch(/^[a-z]{3,6}$/);
    expect([...P.WORDS].sort()).toEqual([...P.WORDS]);
    expect(Math.max(...P.WORDS.map((w) => w.length))).toBe(P.WORD_MAX);
    expect(Object.isFrozen(P.WORDS)).toBe(true);
  });
});

describe('extend — Fred\'s examples', () => {
  test('nothing typed → five words', () => {
    const r = P.extend('');
    expect(r.ok).toBe(true);
    expect(r.value).toMatch(new RegExp('^' + tail(5).source));
    expect(r.words).toBe(5);
  });

  test('`smith` → smith- + four words', () => {
    expect(P.extend('smith').value).toMatch(new RegExp('^smith-' + tail(4).source));
  });

  test('`smith-tax` and `smith-tax-` → three words (the separator is not doubled)', () => {
    expect(P.extend('smith-tax').value).toMatch(new RegExp('^smith-tax-' + tail(3).source));
    expect(P.extend('smith-tax-').value).toMatch(new RegExp('^smith-tax-' + tail(3).source));
  });

  test('the floor: four typed parts still get three words (the 5-part cap yields)', () => {
    const r = P.extend('a-b-c-d');
    expect(r.value).toMatch(new RegExp('^a-b-c-d-' + tail(3).source));
    expect(r.words).toBe(3);
  });

  test('a long name gets fewer words to stay within 64, but never fewer than three', () => {
    const name = 'x'.repeat(30);   // room for exactly 4 budgeted words: 30+1+27 = 58
    const r = P.extend(name, { fill: longestFill() });
    expect(r.words).toBe(4);
    const r2 = P.extend('x'.repeat(40), { fill: longestFill() });
    expect(r2.words).toBe(3);
    expect(r2.value.length).toBeLessThanOrEqual(64);
  });

  test('too long for three words → refused with the limit, nothing written', () => {
    expect(P.extend('x'.repeat(43)).ok).toBe(true);
    expect(P.extend('x'.repeat(44))).toEqual({ ok: false, maxTyped: 43 });
    expect(P.extend('x'.repeat(43) + '-')).toMatchObject({ ok: true });   // a typed '-' is the separator, not extra
  });

  test('surrounding whitespace is dropped; an underscore-only prefix keeps underscores', () => {
    expect(P.extend('  smith ').value).toMatch(new RegExp('^smith-' + tail(4).source));
    expect(P.extend('quo_call').value).toMatch(new RegExp('^quo_call_' + tail(3, '_').source));
    expect(P.extend('quo_call-x').value).toMatch(new RegExp('^quo_call-x-' + tail(3).source));
  });

  test('worst case: every prefix length 0..43 with the longest words stays ≤ 64 and gets ≥ 3 words', () => {
    const fill = longestFill();
    for (let n = 0; n <= 43; n++) {
      const r = P.extend('x'.repeat(n), { fill });
      expect(r.ok).toBe(true);
      expect(r.value.length).toBeLessThanOrEqual(64);
      expect(r.words).toBeGreaterThanOrEqual(3);
      expect(r.value).toMatch(/^[a-z0-9_-]{1,64}$/);   // routes/api.redirects.js SLUG_RE
    }
  });
});

describe('randomness', () => {
  test('draws come from crypto.getRandomValues, never Math.random', () => {
    const spy = jest.spyOn(globalThis.crypto, 'getRandomValues');
    const mr = jest.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random used'); });
    try {
      const seen = new Set();
      for (let i = 0; i < 100; i++) seen.add(P.extend('').value);
      expect(seen.size).toBe(100);
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); mr.mockRestore(); }
  });

  test('randomIndex rejects draws at or above the largest multiple of n (no modulo bias)', () => {
    const n = P.WORDS.length;
    const limit = Math.floor(0x100000000 / n) * n;
    const seq = [limit, 0xffffffff, 5];
    let calls = 0;
    expect(P.randomIndex(n, (buf) => { buf[0] = seq[calls++]; return buf; })).toBe(5);
    expect(calls).toBe(3);
    expect(P.randomIndex(n, (buf) => { buf[0] = limit - 1; return buf; })).toBe((limit - 1) % n);
  });

  test('a broken source fails loudly instead of spinning', () => {
    expect(() => P.randomIndex(10, (buf) => { buf[0] = 0xffffffff; return buf; })).toThrow(/no usable value/);
  });
});

describe('createRoller — pressing again', () => {
  test('re-rolls the words on the same prefix instead of stacking', () => {
    const roll = P.createRoller();
    const a = roll('smith').value;
    const b = roll(a).value;
    expect(b).toMatch(new RegExp('^smith-' + tail(4).source));
    expect(b).not.toBe(a);
  });

  test('an edited result is a new prefix', () => {
    const roll = P.createRoller();
    const a = roll('smith-tax').value;
    const r = roll(a + '-v2');
    expect(r.value.startsWith(a + '-v2-')).toBe(true);
    expect(r.words).toBe(3);   // smith-tax-w-w-w-v2 is already 6 parts: the floor applies
  });

  test('after a refusal the next press starts fresh', () => {
    const roll = P.createRoller();
    expect(roll('x'.repeat(50)).ok).toBe(false);
    expect(roll('smith').value).toMatch(new RegExp('^smith-' + tail(4).source));
  });
});

describe('the Redirects page', () => {
  test('loads the module before its inline script, wires Randomize to randomizeSlug, and has no Math.random slug left', () => {
    const tag = PAGE.indexOf('<script src="/js/slugPhrase.js"></script>');
    expect(tag).toBeGreaterThan(-1);
    expect(tag).toBeLessThan(PAGE.indexOf('<script>'));
    expect(PAGE).toMatch(/E\('f-randomize'\)\.addEventListener\('click', randomizeSlug\);/);
    expect(PAGE).not.toMatch(/Math\.random/);
    expect(PAGE).toMatch(/<input[^>]*id="f-slug"[^>]*maxlength="64"/);
  });

  function fnSrc(name) {
    const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(PAGE);
    if (!m) throw new Error(`function ${name} not found`);
    let depth = 0;
    for (let j = PAGE.indexOf('{', PAGE.indexOf(')', m.index)); j < PAGE.length; j++) {
      if (PAGE[j] === '{') depth++;
      else if (PAGE[j] === '}' && --depth === 0) return PAGE.slice(m.index, j + 1);
    }
    throw new Error(`function ${name}: unbalanced`);
  }

  function bootPage(value) {
    const input = { value };
    const ctx = {
      E: (id) => (id === 'f-slug' ? input : null),
      errs: [], hidden: 0,
      showErr(m) { ctx.errs.push(m); },
      hideErr() { ctx.hidden++; },
      rollSlug: P.createRoller(),
    };
    vm.createContext(ctx);
    vm.runInContext(fnSrc('randomizeSlug') + '\nthis.randomizeSlug = randomizeSlug;', ctx);
    return { ctx, input };
  }

  test('the page builds its roller from the module', () => {
    expect(PAGE).toMatch(/const rollSlug = window\.YCSlugPhrase\.createRoller\(\);/);
  });

  test('randomizeSlug writes the result and clears an old error', () => {
    const { ctx, input } = bootPage('smith');
    ctx.randomizeSlug();
    expect(input.value).toMatch(new RegExp('^smith-' + tail(4).source));
    expect(ctx.hidden).toBe(1);
    expect(ctx.errs).toEqual([]);
  });

  test('a prefix too long is refused: the box is left alone and the error names the limit', () => {
    const long = 'x'.repeat(50);
    const { ctx, input } = bootPage(long);
    ctx.randomizeSlug();
    expect(input.value).toBe(long);
    expect(ctx.errs).toHaveLength(1);
    expect(ctx.errs[0]).toMatch(/43 characters or fewer/);
  });
});
