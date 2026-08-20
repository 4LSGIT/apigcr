// routes/manuals.js
//
// Serves manual content as JSON (lists) and plain text (markdown).
// Rendering is handled entirely client-side in manuals.html.
//
// Routes (auto-mounted at root by server.js — the router owns the /manual
// prefix itself, there is no app.use('/manuals', …)):
//   GET /manual                       → JSON: list of sections
//   GET /manual/:section              → JSON: { section, intro, outro, files }
//   GET /manual/:section/:file        → text/plain: raw markdown content
//
// README handling
// ───────────────
// A section's README.md is the GitHub landing page for that folder: prose
// intro plus a hand-written TOC table. It is deliberately NOT served as a
// chapter — the file list is generated from the filesystem, so a README
// chapter would duplicate it and rot. Instead it is harvested:
//
//   • the TOC table's third column becomes each file's `desc`
//   • everything before that table becomes the section's `intro`
//   • everything after it becomes the section's `outro`
//
// tests/manualReadmeCoverage.test.js guards the drift this creates a
// dependency on (every chapter linked, every link resolvable, every row
// described).
//
// No npm packages required beyond express.

const express     = require('express');
const fs          = require('fs');
const path        = require('path');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

const router      = express.Router();
const MANUALS_DIR = path.join(__dirname, '..', 'manual');

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** "01-workflow-manager" → "Workflow Manager" */
function formatName(slug) {
  return slug
    .replace(/^\d+[-_]/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function getSections() {
  try {
    return fs.readdirSync(MANUALS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort()
      .map(slug => ({ slug, label: formatName(slug) }));
  } catch {
    return [];
  }
}

// ── README harvest ───────────────────────────────────────────

/**
 * A TOC row: | n | [file.md](file.md) | description |
 * The leading cell is ignored (it is a counter), the link's TARGET is
 * ignored (the filename in the label is what we key on), the third cell is
 * the description. Rows without a .md link — separators, the subsystem
 * comparison table in 03-YisraFlow — simply don't match.
 */
const TOC_ROW = /^\s*\|[^|]*\|\s*\[([^\]]+?\.md)\]\([^)]*\)\s*\|\s*([^|]*?)\s*\|/;

function readReadme(sectionSlug) {
  try {
    return fs.readFileSync(path.join(MANUALS_DIR, sectionSlug, 'README.md'), 'utf8');
  } catch {
    return null;
  }
}

/** { fileSlug: description } harvested from the README TOC table. */
function getDescriptions(readmeMd) {
  const out = {};
  if (!readmeMd) return out;
  for (const line of readmeMd.split('\n')) {
    const m = line.match(TOC_ROW);
    if (m) out[m[1].replace(/\.md$/i, '')] = m[2].trim();
  }
  return out;
}

/** Tidy one half of a split README into renderable markdown, or null. */
function tidy(lines, dropLeadingH1) {
  let s = lines.join('\n');
  if (dropLeadingH1) s = s.replace(/^\s*#\s+[^\n]*\n/, ''); // client renders the title
  s = s
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/^(?:-{3,}\s*\n+)+/, '')       // hr that only butted against the table
    .replace(/(?:\n+\s*-{3,})+\s*$/, '')
    .trim();
  return s || null;
}

/**
 * Split a README around its TOC table. The README's own layout already says
 * what belongs above the chapter list and what belongs below it — 05's
 * "Reports and Views are the same system" callout sits after the table,
 * 03's subsystem comparison sits before it — so we honour that rather than
 * flattening everything into one blob.
 *
 * Only the TOC table itself is removed (the app generates that list from the
 * filesystem). Every other table survives as content.
 */
function splitReadme(md) {
  if (!md) return { intro: null, outro: null };
  const lines = md.split('\n');

  // Locate the contiguous table block carrying the .md links.
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!TOC_ROW.test(lines[i])) continue;
    start = i; while (start > 0 && /^\s*\|/.test(lines[start - 1])) start--;
    end   = i; while (end < lines.length - 1 && /^\s*\|/.test(lines[end + 1])) end++;
    break;
  }

  const before = start === -1 ? lines.slice() : lines.slice(0, start);
  const after  = start === -1 ? []            : lines.slice(end + 1);

  // Drop a heading whose only job was to introduce the table ("## Contents").
  // A lead-in sentence ("read these in order:") is kept — it reads correctly
  // directly above the generated list.
  for (let j = before.length - 1; j >= 0; j--) {
    if (!before[j].trim()) { before.pop(); continue; }
    if (/^#{1,6}\s/.test(before[j])) before.pop();
    break;
  }

  return { intro: tidy(before, true), outro: tidy(after, false) };
}

function getFiles(sectionSlug, readmeMd) {
  const dir  = path.join(MANUALS_DIR, sectionSlug);
  const desc = getDescriptions(readmeMd);
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .sort()
      .map(filename => {
        const slug = filename.replace(/\.md$/i, '');
        return { slug, label: formatName(slug), desc: desc[slug] || null };
      });
  } catch {
    return [];
  }
}

function safeResolvePath(sectionSlug, fileSlug) {
  const filename  = fileSlug.endsWith('.md') ? fileSlug : `${fileSlug}.md`;
  const resolved  = path.resolve(MANUALS_DIR, sectionSlug, filename);
  const base      = path.resolve(MANUALS_DIR);
  // Prevent directory traversal
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// ─────────────────────────────────────────────────────────────
// GET /manual → section list
// ─────────────────────────────────────────────────────────────
router.get('/manual', jwtOrApiKey, (req, res) => {
  res.json({ sections: getSections() });
});

// ─────────────────────────────────────────────────────────────
// GET /manual/:section → intro + file list
// ─────────────────────────────────────────────────────────────
router.get('/manual/:section', jwtOrApiKey, (req, res) => {
  const { section } = req.params;
  const sectionDir  = path.join(MANUALS_DIR, section);

  if (!fs.existsSync(sectionDir) || !fs.statSync(sectionDir).isDirectory()) {
    return res.status(404).json({ error: 'Section not found' });
  }

  const readmeMd        = readReadme(section);
  const { intro, outro } = splitReadme(readmeMd);

  res.json({
    section: { slug: section, label: formatName(section) },
    intro,
    outro,
    files: getFiles(section, readmeMd)
  });
});

// ─────────────────────────────────────────────────────────────
// GET /manual/:section/:file → raw markdown
// ─────────────────────────────────────────────────────────────
router.get('/manual/:section/:file', jwtOrApiKey, (req, res) => {
  const { section, file } = req.params;
  const filePath = safeResolvePath(section, file);

  if (!filePath) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.type('text/plain').send(content);
  } catch {
    res.status(500).json({ error: 'Could not read file' });
  }
});

module.exports = router;
