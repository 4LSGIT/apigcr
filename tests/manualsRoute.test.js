// tests/manualsRoute.test.js
//
// manuals-ui S2 — routes/manuals.js, served over a real express app against
// the repo's real manual/ tree. Only the auth dependency is stubbed.
//
//   GET /manual            sections carry `count` (chapters, README excluded)
//                          and `blurb` (the README's first prose sentence,
//                          inline markdown stripped, ≤160 chars)
//   GET /manual/:section   each file's `label` is its own H1, with the
//                          author's counter ("Part 4 — ", "15 — ") dropped and
//                          inline markdown flattened; no H1 → formatName(slug)
//                          (pinned on a temp file through the same helper the
//                          route uses — every real chapter has an H1)
//   section guard          a decoded "..", "../ref" is a 404, not a listing
//                          of markdown outside manual/
//
// Run:  npx jest tests/manualsRoute.test.js

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => jest.fn((req, res, next) => next()));

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const http    = require('http');
const express = require('express');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const router  = require('../routes/manuals');

const MANUALS_DIR = path.join(__dirname, '..', 'manual');

const app = express();
app.use(router);

let server, base, port;
beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

const getJson = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

/** A request whose path is sent byte-for-byte (fetch would normalise "..").  */
function rawGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /manual — section cards', () => {
  let sections;
  beforeAll(async () => {
    const r = await getJson('/manual');
    expect(r.status).toBe(200);
    sections = r.body.sections;
  });

  test('every manual folder is a section, with its chapter count', () => {
    const dirs = fs.readdirSync(MANUALS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(sections.map((s) => s.slug)).toEqual(dirs);
    for (const s of sections) {
      const chapters = fs.readdirSync(path.join(MANUALS_DIR, s.slug))
        .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
      expect({ slug: s.slug, count: s.count }).toEqual({ slug: s.slug, count: chapters.length });
    }
    expect(jwtOrApiKey).toHaveBeenCalled();
  });

  test('blurb = the README\'s first prose sentence, inline markdown stripped', () => {
    const by = Object.fromEntries(sections.map((s) => [s.slug, s.blurb]));
    // a plain first sentence ending in "."
    expect(by['01-YisraCase-overview']).toBe(
      'The core of the system: the records the firm works with every day, and the screens that manage them.');
    // **bold** stripped
    expect(by['06-Client-Facing']).toBe('Everything a client touches directly.');
    // the README opens with a heading then a "---"-free paragraph
    expect(by['08-Admin-Tools']).toBe('Power tools for IT / super-users only.');
  });

  test('a long first sentence is cut at a word, ≤160 chars, with an ellipsis; *emphasis* stripped', () => {
    const flow = sections.find((s) => s.slug === '03-YisraFlow').blurb;
    expect(flow.length).toBeLessThanOrEqual(160);
    expect(flow.endsWith('…')).toBe(true);
    expect(flow.startsWith('YisraFlow is the umbrella name for everything in YisraCase that runs by itself:')).toBe(true);
    expect(flow).not.toMatch(/[*`]/);
    for (const s of sections) {
      expect(typeof s.blurb).toBe('string');
      expect(s.blurb.length).toBeLessThanOrEqual(160);
      expect(s.blurb).not.toMatch(/[*`[\]]/);
    }
  });
});

describe('GET /manual/:section — chapter titles', () => {
  const labelOf = async (sec, slug) => {
    const r = await getJson('/manual/' + sec);
    expect(r.status).toBe(200);
    const f = r.body.files.find((x) => x.slug === slug);
    expect(f).toBeTruthy();
    return f.label;
  };

  test('"# 15 — Trigger System" → counter dropped', async () => {
    expect(await labelOf('03-YisraFlow', '15-triggers')).toBe('Trigger System');
  });
  test('"# Part 4 — Layout & Styling" → "Part N — " dropped', async () => {
    expect(await labelOf('02-YisraForms', '04-layout-and-styling')).toBe('Layout & Styling');
  });
  test('"# Contacts" → as is', async () => {
    expect(await labelOf('01-YisraCase-overview', '02-contacts')).toBe('Contacts');
  });
  test('"# YisraVideo — Overview" → a dash that is not a counter stays', async () => {
    expect(await labelOf('05-Subsystems', '01-YisraVideo')).toBe('YisraVideo — Overview');
  });
  test('"# 14 — Human-in-the-Loop Decisions (`request_decision`)" → backticks stripped, underscore kept', async () => {
    expect(await labelOf('03-YisraFlow', '14-human-in-the-loop'))
      .toBe('Human-in-the-Loop Decisions (request_decision)');
  });

  test('every chapter gets a non-empty plain-text label, desc still harvested', async () => {
    const { body } = await getJson('/manual');
    for (const s of body.sections) {
      const r = await getJson('/manual/' + s.slug);
      for (const f of r.body.files) {
        expect(f.label).toMatch(/\S/);
        expect(f.label).not.toMatch(/^(?:Part\s+)?\d+\s+—/);
        expect(f.label).not.toMatch(/[`*]/);
        expect(f.desc).toMatch(/\S/);
      }
    }
  });
});

describe('no H1 → formatName(slug)', () => {
  const { fileLabel, chapterTitle } = router.helpers;
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-manual-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('a chapter with no "# " line falls back to the prettified slug', () => {
    const p = path.join(dir, '07-no-title-here.md');
    fs.writeFileSync(p, 'Intro text with no heading.\n\n## A subsection\n\nBody.\n');
    expect(fileLabel(p, '07-no-title-here')).toBe('No Title Here');
  });

  test('an H1 after other lines is still found; an h2 is not a title', () => {
    const p = path.join(dir, '08-late.md');
    fs.writeFileSync(p, '<!-- note -->\n\n# 8 — Late *Title*\n');
    expect(fileLabel(p, '08-late')).toBe('Late Title');
    expect(chapterTitle('## Only an h2\n')).toBe(null);
  });
});

test('stripInline: code spans keep their underscores; links, emphasis, bold flatten', () => {
  const { stripInline } = router.helpers;
  expect(stripInline('`a_b_c` and _em_ and **bold** and *it* and [text](x.md)'))
    .toBe('a_b_c and em and bold and it and text');
  expect(stripInline('snake_case_name stays')).toBe('snake_case_name stays');
  // markers INSIDE code are content, not emphasis
  expect(stripInline('the `_meta_` key and `*glob*`')).toBe('the _meta_ key and *glob*');
});

describe('section guard', () => {
  test.each(['/manual/..', '/manual/%2E%2E', '/manual/..%2Fref', '/manual/..%2F..%2Fref', '/manual/nope'])(
    '%s → 404', async (p) => {
      const r = await rawGet(p);
      expect(r.status).toBe(404);
    });
});
