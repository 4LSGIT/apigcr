// tests/manualReadmeCoverage.test.js
//
// The section READMEs are no longer decorative. routes/manuals.js harvests
// them at request time: the TOC table's third column becomes the description
// under each chapter in the app's section list, and the prose around the
// table becomes the section intro/outro. Two failure modes follow, both
// silent in production:
//
//   1. A chapter added to the folder but not to the README renders with no
//      description (it still LISTS — the list is filesystem-derived — it just
//      looks half-finished). This is exactly how 14-human-in-the-loop.md sat
//      undescribed.
//   2. A relative link in any manual page that points at a file that no
//      longer exists. manuals.html now routes these clicks internally, so a
//      rotted link is a dead no-op rather than a visible 404.
//
// Pure filesystem scan — no DB, no server.

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const MANUALS_DIR = path.join(ROOT, 'manual');

// Must stay in sync with TOC_ROW in routes/manuals.js.
const TOC_ROW = /^\s*\|[^|]*\|\s*\[([^\]]+?\.md)\]\([^)]*\)\s*\|\s*([^|]*?)\s*\|/;

const MD_LINK = /\]\(([^)\s]+)\)/g;

const sections = fs.readdirSync(MANUALS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

const chaptersOf = sec =>
  fs.readdirSync(path.join(MANUALS_DIR, sec))
    .filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort();

function tocRows(sec) {
  const p = path.join(MANUALS_DIR, sec, 'README.md');
  if (!fs.existsSync(p)) return null;
  const rows = new Map(); // filename → description
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(TOC_ROW);
    if (m) rows.set(m[1], m[2].trim());
  }
  return rows;
}

test('the manual tree is non-trivial (guards the scan itself from rotting)', () => {
  expect(sections.length).toBeGreaterThanOrEqual(5);
  expect(sections.reduce((n, s) => n + chaptersOf(s).length, 0)).toBeGreaterThanOrEqual(40);
});

test('every manual section has a README.md', () => {
  const missing = sections.filter(
    s => !fs.existsSync(path.join(MANUALS_DIR, s, 'README.md')));
  expect(missing).toEqual([]);
});

test('every chapter is listed in its section README, with a description', () => {
  const problems = [];

  for (const sec of sections) {
    const rows = tocRows(sec);
    if (!rows) continue; // covered by the previous test

    for (const file of chaptersOf(sec)) {
      if (!rows.has(file)) {
        problems.push(`${sec}/${file} — in the folder, not in README.md`);
      } else if (!rows.get(file)) {
        problems.push(`${sec}/${file} — README row has an empty description`);
      }
    }

    for (const file of rows.keys()) {
      if (!fs.existsSync(path.join(MANUALS_DIR, sec, file))) {
        problems.push(`${sec}/README.md links ${file} — no such file`);
      }
    }
  }

  expect(problems).toEqual([]);
});

test('every relative link in the manual resolves', () => {
  const problems = [];
  let checked = 0;

  for (const sec of sections) {
    for (const file of fs.readdirSync(path.join(MANUALS_DIR, sec))) {
      if (!file.endsWith('.md')) continue;
      const src = fs.readFileSync(path.join(MANUALS_DIR, sec, file), 'utf8');
      const where = `${sec}/${file}`;

      MD_LINK.lastIndex = 0;
      let m;
      while ((m = MD_LINK.exec(src))) {
        const raw = m[1];
        if (/^(?:https?:|mailto:|tel:|#)/i.test(raw)) continue;
        const target = raw.split('#')[0];
        if (!target) continue;

        checked++;
        // Links resolve relative to the file's own directory, both on GitHub
        // and (via manuals.html's router) in the app.
        const abs = path.resolve(MANUALS_DIR, sec, target);
        if (!fs.existsSync(abs)) {
          problems.push(`${where} → ${raw}`);
        }
      }
    }
  }

  expect(checked).toBeGreaterThanOrEqual(80);
  expect(problems).toEqual([]);
});
