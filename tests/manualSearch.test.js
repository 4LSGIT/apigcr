// tests/manualSearch.test.js
//
// manuals-ui S3 — GET /manual/search and the parser under it, in
// routes/manuals.js. The route is served over a real express app against the
// repo's real manual/ tree; only the auth dependency is stubbed. The parser
// and ranking are also driven on synthetic chapters through the module's own
// chapterEntries / searchIndex (the same functions the route uses).
//
//   route order   /manual/search is registered before /manual/:section, so
//                 it answers as search (400 on a short query), never as a
//                 404 "section named search"; real sections still list
//   parser        ATX headings only OUTSIDE fenced code (``` and ~~~, closed
//                 by the same character, at least as long); heading text is
//                 what the browser renders (inline code / emphasis / links
//                 flattened, closing #s dropped); headingIndex counts every
//                 h1..h6 in order, 0 = the first; body before any heading is
//                 headingIndex null; HTML comments are not text
//   query         AND across terms within one heading block; case-
//                 insensitive; regex metacharacters are literal; < 2 chars
//                 (after trim) or > 200 → 400
//   ranking       title block > heading match > body match, then term
//                 frequency; capped at 50 with `total` uncapped
//   snippet       plain text around the first hit, ≤ ~160 chars + ellipses
//
// The rendered-DOM side of headingIndex (marked's h1..h6 in the browser) is
// checked over the whole corpus by scripts/mobile-survey/manualOrdinals.js,
// not here.
//
// Run:  npx jest tests/manualSearch.test.js

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => next()));

const express = require('express');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const router  = require('../routes/manuals');

const { parseChapter, chapterEntries, searchIndex, SEARCH_CAP } = router.helpers;

const app = express();
app.use(router);

let server, base;
beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

const get = async (p) => {
  const res = await fetch(base + p);
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};
const search = (q) => get('/manual/search?q=' + encodeURIComponent(q));

/** Synthetic index: [{ file, md }] → entries, through the route's own indexer. */
const indexOf = (chapters) => chapters.flatMap(({ file, md, section = 'sec' }) =>
  chapterEntries({ section, sectionLabel: 'Section', file, md }));

// ─────────────────────────────────────────────────────────────
describe('route order', () => {
  test('/manual/search answers as search, not as a section named "search"', async () => {
    const r = await search('workflow');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.results)).toBe(true);
    expect(r.body.results.length).toBeGreaterThan(0);
    expect(jwtOrApiKey).toHaveBeenCalled();
    // no q at all: the search route's 400, not :section's 404
    const bare = await get('/manual/search');
    expect(bare.status).toBe(400);
    expect(bare.body.error).toMatch(/at least 2 characters/);
  });

  test('a real section still lists', async () => {
    const r = await get('/manual/03-YisraFlow');
    expect(r.status).toBe(200);
    expect(r.body.section.slug).toBe('03-YisraFlow');
    expect(r.body.files.length).toBeGreaterThan(5);
  });
});

// ─────────────────────────────────────────────────────────────
describe('parser', () => {
  test('a heading as the very first line is index 0; levels and order are kept', () => {
    const { headings } = parseChapter('# Title\nintro\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n');
    expect(headings).toEqual([
      { level: 1, text: 'Title' }, { level: 2, text: 'Two' }, { level: 3, text: 'Three' },
      { level: 4, text: 'Four' }, { level: 5, text: 'Five' }, { level: 6, text: 'Six' }]);
  });

  test('# lines inside ``` and ~~~ fences are code, not headings', () => {
    const md = [
      '# Top',
      '```bash',
      '# a shell comment',
      '## still code',
      '```',
      '## Real',
      '~~~',
      '# tilde-fenced comment',
      '```',                     // a backtick line does NOT close a ~~~ fence
      '# still inside',
      '~~~',
      '### After',
      '````md',
      '```',                     // shorter: does not close a 4-backtick fence
      '# inside the long fence',
      '````',
      '#### Last',
    ].join('\n');
    expect(parseChapter(md).headings.map((h) => h.text)).toEqual(['Top', 'Real', 'After', 'Last']);
  });

  test('heading text is the rendered text: inline code, emphasis, links, escapes, closing #s', () => {
    const md = [
      '# 15 — The `send_email` *step*',
      '## Uses **bold** and [a link](other.md#x) ##',
      '### Escaped \\_name\\_ &amp; <code>tag</code>',
      '#### `<input>` in code is text',
      '#hashtag is not a heading',
      '    # four spaces is indented code, not a heading',
      '   ## three spaces is still one',
    ].join('\n');
    expect(parseChapter(md).headings.map((h) => h.text)).toEqual([
      '15 — The send_email step',
      'Uses bold and a link',
      'Escaped _name_ & tag',
      '<input> in code is text',
      'three spaces is still one',
    ]);
  });

  test('body lines belong to the nearest heading above; text before any heading is headingIndex null', () => {
    const md = 'preface words\n# A\nalpha body\n## B\nbravo body\n```\n# zebra in code\n```\nafter code\n';
    const { blocks } = parseChapter(md);
    expect(blocks).toEqual([
      { headingIndex: null, heading: '', text: 'preface words' },
      { headingIndex: 0, heading: 'A', text: 'alpha body' },
      { headingIndex: 1, heading: 'B', text: 'bravo body # zebra in code after code' },
    ]);
  });

  test('HTML comments are not text; inline markdown flattens across wrapped lines', () => {
    const md = '# A\nvisible <!-- hidden one --> too\nkept line\n<!-- multi\nline hidden -->\nthe `collect()\n` call and **wrapped\nbold** text\n';
    const { blocks } = parseChapter(md);
    expect(blocks[0].text).toBe('visible too kept line the collect() call and wrapped bold text');
    expect(blocks[0].text).not.toMatch(/hidden|[`*]/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('query', () => {
  const idx = indexOf([
    { file: 'a', md: '# Alpha\n## One\nred apple\n## Two\nred pear\n## Three\ngreen apple\n' },
    { file: 'b', md: '# Beta\n## Math\ncall f(x) here, and C:\\path\\to and a+b*c [x]\n## Dots\nabc only\n' },
  ]);

  test('every term must occur in the same heading block (AND), case-insensitively', () => {
    const r = searchIndex(idx, 'RED Apple');
    expect(r.results.map((x) => x.heading)).toEqual(['One']);
    expect(searchIndex(idx, 'red').results.map((x) => x.heading).sort()).toEqual(['One', 'Two']);
    // terms in DIFFERENT blocks of one chapter do not match
    expect(searchIndex(idx, 'pear green').total).toBe(0);
  });

  test('regex metacharacters match literally and never throw', () => {
    expect(searchIndex(idx, 'f(x)').results.map((x) => x.heading)).toEqual(['Math']);
    expect(searchIndex(idx, 'c:\\path').results.map((x) => x.heading)).toEqual(['Math']);
    expect(searchIndex(idx, 'a+b*c').results.map((x) => x.heading)).toEqual(['Math']);
    expect(searchIndex(idx, '[x]').results.map((x) => x.heading)).toEqual(['Math']);
    expect(searchIndex(idx, 'a.c').total).toBe(0);           // "." is not a wildcard
    for (const q of ['(', '[', '*', '\\', ')(', '?+', '.*']) expect(() => searchIndex(idx, q)).not.toThrow();
  });

  test.each(['(', '[', '*', '\\', '(?<x', '.*'])('route: %s is a 200 with a results array', async (q) => {
    const r = await search(q + q);   // two characters
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.results)).toBe(true);
  });

  test.each(['', ' ', 'a', '  a  '])('route: %j (under 2 characters after trim) is a 400', async (q) => {
    expect((await search(q)).status).toBe(400);
  });

  test('route: over 200 characters is a 400', async () => {
    expect((await search('x'.repeat(201))).status).toBe(400);
    expect((await search('x'.repeat(200))).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────
describe('ranking and cap', () => {
  const idx = indexOf([
    { file: 'body', md: '# Notes\n## Once\nwidget\n## Many\nwidget widget widget widget widget\n' },
    { file: 'head', md: '# Other\n## Widget setup\none widget mention\n' },
    { file: 'title', md: '# Widget Guide\nintro without the word\n## More\nwidget\n' },
  ]);

  test('chapter title block, then heading match, then body by term frequency', () => {
    const r = searchIndex(idx, 'widget');
    expect(r.results.map((x) => `${x.file}#${x.headingIndex}`)).toEqual([
      'title#0',   // title holds the term
      'head#1',    // heading holds it
      'body#2',    // body, 5 occurrences — ahead of body#1 despite manual order
      'body#1',    // body, 1 occurrence — before title#1 by manual order
      'title#1',
    ]);
    expect(r.results[0]).toMatchObject({ title: 'Widget Guide', heading: 'Widget Guide', headingIndex: 0 });
  });

  test('capped at SEARCH_CAP; total is the uncapped count', () => {
    const many = indexOf([{ file: 'many', md: '# Many\n' + Array.from({ length: 70 }, (_, i) => `## H${i}\nneedle\n`).join('') }]);
    const r = searchIndex(many, 'needle');
    expect(SEARCH_CAP).toBe(50);
    expect(r.results).toHaveLength(50);
    expect(r.total).toBe(70);
  });

  test('route: a common term over the real corpus is capped, with the full total', async () => {
    const r = await search('workflow');
    expect(r.body.results).toHaveLength(50);
    expect(r.body.total).toBeGreaterThan(50);
    for (const x of r.body.results) {
      expect(Object.keys(x).sort()).toEqual(['file', 'heading', 'headingIndex', 'section', 'sectionLabel', 'snippet', 'title']);
    }
    expect(r.body.results[0]).toMatchObject({ section: '03-YisraFlow', file: '02-workflows', headingIndex: 0, sectionLabel: 'YisraFlow' });
  });
});

// ─────────────────────────────────────────────────────────────
describe('results', () => {
  test('a hit inside a fenced block reports the enclosing heading', () => {
    const idx = indexOf([{ file: 'c', md: '# Chapter\n## Setup\nprose\n## Code part\n```bash\n# zebracomment here\nrun it\n```\n## After\nmore\n' }]);
    const r = searchIndex(idx, 'zebracomment');
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ heading: 'Code part', headingIndex: 2 });
  });

  test('route: the same over the real corpus (a # line inside a fence)', async () => {
    // manual/04-Integrations/02-connections-live-test.md: "# Sub-step 1 — change auth_url only" is a
    // comment inside a fenced block under "## Test 5: PUT merge fix verification (Slice 5)"
    const r = await search('Sub-step 1 — change auth_url only');
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({
      file: '02-connections-live-test', heading: 'Test 5: PUT merge fix verification (Slice 5)' });
  });

  test('snippet is plain text: markdown syntax stripped, no tags, around the first hit', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(12);
    const md = `# T\n## H\n${filler}Use **bold** and \`code_span\` and [a link](x.md) with <br> &amp; the quasar here. ${filler}\n`;
    const r = searchIndex(indexOf([{ file: 's', md }]), 'quasar');
    const s = r.results[0].snippet;
    expect(s).toMatch(/^…/);
    expect(s).toMatch(/…$/);
    expect(s.length).toBeLessThanOrEqual(162);
    expect(s).toContain('Use bold and code_span and a link with & the quasar here.');
    expect(s).not.toMatch(/[*`<>[\]]|&amp;/);
  });

  test('a short block\'s snippet is its whole text', () => {
    const r = searchIndex(indexOf([{ file: 's', md: '# T\n## H\nshort *quasar* line\n' }]), 'quasar');
    expect(r.results[0].snippet).toBe('short quasar line');
  });
});
