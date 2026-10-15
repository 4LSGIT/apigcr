// routes/manuals.js
//
// Serves manual content as JSON (lists) and plain text (markdown).
// Rendering is handled entirely client-side in manuals.html.
//
// Routes (auto-mounted at root by server.js — the router owns the /manual
// prefix itself, there is no app.use('/manuals', …)):
//   GET /manual                       → JSON: list of sections
//                                        [{ slug, label, count, blurb }]
//   GET /manual/:section              → JSON: { section, intro, outro, files }
//                                        files: [{ slug, label, desc }]
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
// described). The README's first prose sentence is also the section's
// `blurb` on the index cards.
//
// Chapter titles
// ──────────────
// A file's `label` is its own `# ` heading, not its filename: the counter
// authors prefix ("Part 4 — ", "15 — ") is dropped (the list numbers chapters
// itself) and inline markdown is flattened to plain text. A file with no H1
// falls back to formatName(slug). Only the first TITLE_HEAD_BYTES of each
// chapter are read, per request — no cache, so a manual edit shows on the
// next request and nothing can go stale; a section is ~16 small reads.
// tests/manualsRoute.test.js pins the shapes.
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

function sectionSlugs() {
  try {
    return fs.readdirSync(MANUALS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

function getSections() {
  return sectionSlugs().map(slug => ({
    slug,
    label: formatName(slug),
    count: chapterFilenames(slug).length,
    blurb: readmeBlurb(readReadme(slug))
  }));
}

/** The chapter files of a section, sorted: every .md except the README. */
function chapterFilenames(sectionSlug) {
  try {
    return fs.readdirSync(path.join(MANUALS_DIR, sectionSlug))
      .filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .sort();
  } catch {
    return [];
  }
}

// ── Inline markdown → plain text ─────────────────────────────

/**
 * Flatten inline markdown for a plain-text label: links and images keep their
 * text, code spans keep their content (and are shielded from the emphasis
 * pass — `request_decision` must keep its underscore), emphasis markers go.
 */
function stripInline(s) {
  const code = [];
  return String(s)
    .replace(/`+([^`]*?)`+/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?![\w])/g, '$1$2')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)])
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Chapter titles ───────────────────────────────────────────

const TITLE_HEAD_BYTES = 4096;

/** "Part 4 — ", "15 — " — the author's counter; the app numbers the list. */
const TITLE_COUNTER = /^(?:Part\s+)?\d+\s+[—–-]\s+/i;

/** Plain-text title from a chapter's first `# ` line, or null. */
function chapterTitle(md) {
  if (!md) return null;
  const m = String(md).match(/^#[ \t]+(.+?)[ \t#]*$/m);
  if (!m) return null;
  const title = stripInline(m[1].replace(TITLE_COUNTER, ''));
  return title || null;
}

/** First TITLE_HEAD_BYTES of a file as text ('' when unreadable). */
function readHead(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(TITLE_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, TITLE_HEAD_BYTES, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/** A chapter's display label: its H1, else the slug prettified. */
function fileLabel(filePath, slug) {
  return chapterTitle(readHead(filePath)) || formatName(slug);
}

// ── Section blurbs ───────────────────────────────────────────

const BLURB_MAX = 160;

/**
 * The first sentence of a README's first prose paragraph, inline markdown
 * stripped, at most BLURB_MAX characters (cut at a word, with an ellipsis).
 * Headings, rules, tables, quotes, lists and fenced code are not prose.
 */
function readmeBlurb(md) {
  if (!md) return null;
  const lines = String(md).split('\n');
  const para = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; if (para.length) break; continue; }
    if (fence) continue;
    const blank = !line.trim();
    const block = /^\s*(#|>|\||[-*+]\s|\d+[.)]\s|<)/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
    if (para.length && (blank || block)) break;
    if (!blank && !block) para.push(line.trim());
  }
  if (!para.length) return null;
  const text = stripInline(para.join(' '));
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  let s = (m ? m[0] : text).trim();
  if (s.length > BLURB_MAX) {
    const cut = s.slice(0, BLURB_MAX - 1);
    const sp  = cut.lastIndexOf(' ');
    s = (sp > BLURB_MAX / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:—–-]+$/, '') + '…';
  }
  return s || null;
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
  return chapterFilenames(sectionSlug).map(filename => {
    const slug = filename.replace(/\.md$/i, '');
    return { slug, label: fileLabel(path.join(dir, filename), slug), desc: desc[slug] || null };
  });
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

  // Express decodes %2F and %2E in params: "..", "../ref" would otherwise
  // list (and now read the heads of) markdown outside manual/. A section is
  // one of manual/'s own folders, nothing else.
  if (!sectionSlugs().includes(section) ||
      !fs.existsSync(sectionDir) || !fs.statSync(sectionDir).isDirectory()) {
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
// Pure helpers, for tests/manualsRoute.test.js (no-H1 fallback on a temp file).
module.exports.helpers = { formatName, stripInline, chapterTitle, readmeBlurb, fileLabel };
