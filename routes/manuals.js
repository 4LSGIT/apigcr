// routes/manuals.js
//
// Serves manual content as JSON (lists) and plain text (markdown).
// Rendering is handled entirely client-side in manuals.html.
//
// Routes:
//   GET /manuals                      → JSON: list of sections
//   GET /manuals/:section             → JSON: list of files in section
//   GET /manuals/:section/:file       → text/plain: raw markdown content
//
// No npm packages required beyond express.
// Mount: app.use('/manuals', require('./routes/manuals'));

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

function getFiles(sectionSlug) {
  const dir = path.join(MANUALS_DIR, sectionSlug);
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .sort()
      .map(filename => ({
        slug:  filename.replace(/\.md$/i, ''),
        label: formatName(filename.replace(/\.md$/i, ''))
      }));
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
// GET /manuals → section list
// ─────────────────────────────────────────────────────────────
router.get('/manual', jwtOrApiKey, (req, res) => {
  res.json({ sections: getSections() });
});

// ─────────────────────────────────────────────────────────────
// GET /manuals/:section → file list
// ─────────────────────────────────────────────────────────────
router.get('/manual/:section', jwtOrApiKey, (req, res) => {
  const { section } = req.params;
  const sectionDir  = path.join(MANUALS_DIR, section);

  if (!fs.existsSync(sectionDir) || !fs.statSync(sectionDir).isDirectory()) {
    return res.status(404).json({ error: 'Section not found' });
  }

  res.json({
    section: { slug: section, label: formatName(section) },
    files:   getFiles(section)
  });
});

// ─────────────────────────────────────────────────────────────
// GET /manuals/:section/:file → raw markdown
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