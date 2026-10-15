// routes/manuals.js
//
// Serves manual content as JSON (lists) and plain text (markdown).
// Rendering is handled entirely client-side in manuals.html.
//
// Routes (auto-mounted at root by server.js — the router owns the /manual
// prefix itself, there is no app.use('/manuals', …)):
//   GET /manual                       → JSON: list of sections
//                                        [{ slug, label, count, blurb }]
//   GET /manual/search?q=             → JSON: { q, total, results } — full-text
//                                        search of every chapter (see Search)
//   GET /manual/:section              → JSON: { section, intro, outro, files }
//                                        files: [{ slug, label, desc }]
//   GET /manual/:section/:file        → text/plain: raw markdown content
//
// `search` is RESERVED: /manual/search is registered before /manual/:section
// (or Express would route it as a section named "search"), and manuals.html's
// router reads #/search/<q> as the results view. Never name a manual folder
// "search" (tests/manualReadmeCoverage.test.js checks).
//
// Section names and card blurbs
// ─────────────────────────────
// manual/README.md's "Sections" table — | n | [Label](folder/) | description |
// — names each section (`label`, everywhere a section is named) and supplies
// its index-card `blurb`. A folder with no row there falls back to
// formatName(slug) and its own README's first sentence (below).
// tests/manualReadmeCoverage.test.js requires a row for every folder.
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
// described). The README's first prose sentence is the section's fallback
// `blurb` on the index cards (the root Sections table wins, above).
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
// Search
// ──────
// GET /manual/search?q= searches chapter bodies (not READMEs). The index is
// built lazily on the first search and kept for the process — the manual is
// static per deploy. Each chapter is cut into heading blocks: every ATX
// heading (#..######) OUTSIDE fenced code (``` / ~~~) opens one, and each
// body line — fenced code included, HTML comments excluded — belongs to the
// nearest heading above it. A result is one block in which EVERY
// whitespace-separated term occurs (case-insensitive substring of the plain
// text — no regex is built from the query). Ranked: the chapter's own title
// block when the title holds every term, then blocks whose heading holds
// every term, then body matches; within a tier by total term frequency, then
// manual order. Capped at SEARCH_CAP (`total` is the uncapped count).
// `headingIndex` is the heading's ordinal among ALL the chapter's h1..h6
// (0 = the first, normally the H1; null = text above any heading) — the
// count the browser gets from the rendered chapter, which is how the client
// finds the heading (scripts/mobile-survey/manualOrdinals.js checks the two
// agree over the whole corpus). Everything returned is plain text: the client escapes
// and highlights. tests/manualSearch.test.js pins the parser and the route.
// Cost (Oct 2026, 82 chapters / ~1.15 MB): ~1.4k blocks, ~4 MB of heap,
// 30–55 ms to build on the first search, under 2 ms a query after that.
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
  const named = rootSections();
  return sectionSlugs().map(slug => ({
    slug,
    label: sectionLabel(slug, named),
    count: chapterFilenames(slug).length,
    blurb: sectionBlurb(slug, named)
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
  return clampBlurb(m ? m[0] : text);
}

/** At most BLURB_MAX characters, cut at a word, with an ellipsis. */
function clampBlurb(text) {
  let s = String(text).trim();
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

// ── Root README: section names + card blurbs ─────────────────

/** A Sections row: | n | [Label](folder/) | description | — a folder link, no .md. */
const SECTION_ROW = /^\s*\|[^|]*\|\s*\[([^\]]+)\]\((?:\.\/)?([^)\s/]+)\/?\)\s*\|\s*(.*?)\s*\|\s*$/;

/** { folder: { label, desc } } from manual/README.md's Sections table. Plain text. */
function rootSections() {
  const out = {};
  let md;
  try { md = fs.readFileSync(path.join(MANUALS_DIR, 'README.md'), 'utf8'); } catch { return out; }
  for (const line of md.split('\n')) {
    const m = line.match(SECTION_ROW);
    if (!m || /\.md$/i.test(m[2])) continue;
    out[m[2]] = { label: stripInline(m[1]) || null, desc: stripInline(m[3]) || null };
  }
  return out;
}

/** A section's display name: its root README label, else the slug prettified. */
function sectionLabel(slug, named) {
  return (named || rootSections())[slug]?.label || formatName(slug);
}

/** A section's card blurb: its root README description, else its own README's first sentence. */
function sectionBlurb(slug, named) {
  const desc = (named || rootSections())[slug]?.desc;
  return desc ? clampBlurb(desc) : readmeBlurb(readReadme(slug));
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

// ── Search ───────────────────────────────────────────────────

const SEARCH_MIN   = 2;     // characters, after trimming
const SEARCH_MAX   = 200;   // characters
const SEARCH_TERMS = 8;     // terms beyond this are ignored
const SEARCH_CAP   = 50;    // results returned
const SNIPPET_LEN  = 160;   // characters of plain text around the first hit

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Markdown inline → the text a browser shows. Code spans and backslash
 *  escapes are set aside first — both are literal (`<input>` is text, not a
 *  tag; \_x\_ is not emphasis) — then tags are dropped, entities resolved,
 *  and stripInline flattens links and emphasis. */
function plainInline(s) {
  const lit = [];
  const keep = c => `\u0001${lit.push(c) - 1}\u0001`;
  const shielded = String(s)
    .replace(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _t, c) => keep(c.trim()))
    .replace(/\\([!-/:-@[-`{-~])/g, (_, c) => keep(c))
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e) => ENTITIES[e]);
  return stripInline(shielded).replace(/\u0001(\d+)\u0001/g, (_, i) => lit[Number(i)]);
}

/** One body line outside code, block syntax removed ('' for rules and table
 *  separators). Inline markdown is flattened per paragraph (plainInline), not
 *  per line: a code span or **bold** may wrap onto the next line. */
function unblockLine(line) {
  let s = line;
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(s)) return '';                       // rule
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(s)) return '';    // table separator
  s = s.replace(/^\s*(?:>\s?)+/, '')                                             // quote markers
       .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');                // list marker, task box
  if (/^\s*\|/.test(s)) s = s.replace(/^\s*\||\|\s*$/g, '').replace(/\s*\|\s*/g, ' · ');
  return s.trim();
}

/** An ATX heading line (outside code) → { level, text } or null. The text is
 *  what the browser renders: closing #s dropped, inline markdown flattened. */
function atxHeading(line) {
  const m = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/);
  if (!m) return null;
  const raw = (m[2] || '').replace(/(?:^|[ \t]+)#+$/, '');
  return { level: m[1].length, text: plainInline(raw) };
}

/**
 * A chapter → { headings: [{ level, text }], blocks: [{ headingIndex, heading, text }] }.
 * A heading's block carries its ordinal among all headings; body text before
 * the first heading is a block with headingIndex null. Fenced code (``` or
 * ~~~, closed by the same character at least as long) never opens a heading,
 * and its lines are searchable as they stand. HTML comments are not body text.
 */
function parseChapter(md) {
  const headings = [];
  const blocks = [];
  let cur = { headingIndex: null, heading: '', lines: [] };
  let fence = null;          // { ch, len } while inside a fenced block
  let comment = false;       // inside a multi-line <!-- -->
  let para = [];             // the current paragraph's lines, block syntax removed
  const endPara = () => {
    if (para.length) { const t = plainInline(para.join(' ')); if (t) cur.lines.push(t); }
    para = [];
  };
  const flush = () => { endPara(); if (cur.headingIndex !== null || cur.lines.length) blocks.push(cur); };

  for (const line of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) { fence = null; continue; }
      if (line.trim()) cur.lines.push(line.trim());
      continue;
    }
    let s = line;
    if (comment) {
      const end = s.indexOf('-->');
      if (end === -1) continue;
      comment = false;
      s = s.slice(end + 3);
    }
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    const open = s.indexOf('<!--');
    if (open !== -1) { comment = true; s = s.slice(0, open); }

    const f = s.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) { endPara(); fence = { ch: f[1][0], len: f[1].length }; continue; }

    const h = atxHeading(s);
    if (h) {
      flush();
      cur = { headingIndex: headings.length, heading: h.text, lines: [] };
      headings.push(h);
      continue;
    }
    const t = unblockLine(s);
    if (t) para.push(t); else endPara();
  }
  flush();
  return {
    headings,
    blocks: blocks.map(b => ({ headingIndex: b.headingIndex, heading: b.heading, text: b.lines.join(' ') }))
  };
}

/** One chapter's index entries — one per heading block. */
function chapterEntries({ section, sectionLabel: secLabel, file, md }) {
  const title = chapterTitle(md) || formatName(file);
  return parseChapter(md).blocks.map(b => ({
    section, sectionLabel: secLabel, file, title,
    titleLower: title.toLowerCase(),
    heading: b.heading, headingIndex: b.headingIndex,
    headingLower: b.heading.toLowerCase(),
    text: b.text, textLower: b.text.toLowerCase()
  }));
}

let searchIndexCache = null;

/** Every chapter's blocks, built once per process (the manual is static per deploy). */
function getSearchIndex() {
  if (searchIndexCache) return searchIndexCache;
  const named = rootSections();
  const entries = [];
  for (const sec of sectionSlugs()) {
    const secLabel = sectionLabel(sec, named);
    for (const filename of chapterFilenames(sec)) {
      let md;
      try { md = fs.readFileSync(path.join(MANUALS_DIR, sec, filename), 'utf8'); } catch { continue; }
      entries.push(...chapterEntries({ section: sec, sectionLabel: secLabel, file: filename.replace(/\.md$/i, ''), md }));
    }
  }
  searchIndexCache = entries;
  return entries;
}

function countOf(hay, term) {
  let n = 0;
  for (let i = hay.indexOf(term); i !== -1; i = hay.indexOf(term, i + term.length)) n++;
  return n;
}

/** ~SNIPPET_LEN characters of `text` around the first term found, cut at words. */
function snippetOf(text, lower, terms) {
  if (text.length <= SNIPPET_LEN) return text;
  let at = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i !== -1 && (at === -1 || i < at)) at = i; }
  const hit = at === -1 ? 0 : at;
  let end   = Math.min(text.length, Math.max(0, hit - Math.floor(SNIPPET_LEN / 3)) + SNIPPET_LEN);
  let start = Math.max(0, end - SNIPPET_LEN);
  if (start > 0) { const sp = text.indexOf(' ', start); if (sp !== -1 && sp < hit) start = sp + 1; }
  if (end < text.length) { const sp = text.lastIndexOf(' ', end); if (sp > start && sp > hit) end = sp; }
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/** Run a (trimmed) query over the index: { total, results ≤ SEARCH_CAP }. */
function searchIndex(entries, q) {
  const terms = [...new Set(String(q).toLowerCase().split(/\s+/).filter(Boolean))].slice(0, SEARCH_TERMS);
  if (!terms.length) return { total: 0, results: [] };
  const hits = [];
  entries.forEach((e, order) => {
    const hay = e.headingLower + '\n' + e.textLower;
    if (!terms.every(t => hay.includes(t))) return;
    const tier = (e.headingIndex === 0 && terms.every(t => e.titleLower.includes(t))) ? 3
               : (e.headingIndex !== null && terms.every(t => e.headingLower.includes(t))) ? 2 : 1;
    let freq = 0;
    for (const t of terms) freq += countOf(hay, t);
    hits.push({ e, tier, freq, order });
  });
  hits.sort((a, b) => b.tier - a.tier || b.freq - a.freq || a.order - b.order);
  return {
    total: hits.length,
    results: hits.slice(0, SEARCH_CAP).map(({ e }) => ({
      section: e.section, sectionLabel: e.sectionLabel, file: e.file, title: e.title,
      heading: e.heading, headingIndex: e.headingIndex,
      snippet: snippetOf(e.text, e.textLower, terms)
    }))
  };
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
// GET /manual/search?q= → ranked heading blocks (plain text)
// MUST stay above /manual/:section — see the header.
// ─────────────────────────────────────────────────────────────
router.get('/manual/search', jwtOrApiKey, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.replace(/\s+/g, ' ').trim() : '';
  if (q.length < SEARCH_MIN) {
    return res.status(400).json({ error: `Type at least ${SEARCH_MIN} characters to search.` });
  }
  if (q.length > SEARCH_MAX) {
    return res.status(400).json({ error: `Search is limited to ${SEARCH_MAX} characters.` });
  }
  try {
    const { total, results } = searchIndex(getSearchIndex(), q);
    res.json({ q, total, results });
  } catch {
    res.status(500).json({ error: 'Search failed' });
  }
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
    section: { slug: section, label: sectionLabel(section) },
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
module.exports.helpers = {
  formatName, stripInline, chapterTitle, readmeBlurb, fileLabel,
  rootSections, sectionLabel, sectionBlurb,
  parseChapter, chapterEntries, searchIndex, getSearchIndex, SEARCH_CAP
};
