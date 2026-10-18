// services/assistantKnowledgeService.js
// Read-only search over the shipped YisraCase manual. This gives the assistant
// product knowledge without trusting its pretraining or putting manuals in SQL.

'use strict';

const fs = require('fs');
const path = require('path');

const MANUAL_ROOT = path.join(__dirname, '..', 'manual');
let cache = null;

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.isFile() && ent.name.endsWith('.md') && ent.name !== 'README.md') out.push(full);
  }
  return out;
}

function docs() {
  if (cache) return cache;
  cache = walk(MANUAL_ROOT).map((file) => {
    const markdown = fs.readFileSync(file, 'utf8');
    const rel = path.relative(MANUAL_ROOT, file).replace(/\\/g, '/');
    const title = (markdown.match(/^#\s+(.+)$/m) || [null, rel])[1];
    const text = markdown
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#>*_`|~-]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return { rel, title, text, lower: `${title} ${text}`.toLowerCase() };
  });
  return cache;
}

function termsOf(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[a-z0-9_]{2,}/g) || [])].slice(0, 10);
}

function excerpt(doc, terms) {
  let at = -1;
  for (const term of terms) {
    const n = doc.lower.indexOf(term);
    if (n >= 0 && (at < 0 || n < at)) at = n;
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - 180);
  const end = Math.min(doc.text.length, start + 1200);
  return `${start ? '…' : ''}${doc.text.slice(start, end)}${end < doc.text.length ? '…' : ''}`;
}

function search(query, limit = 5) {
  const terms = termsOf(query);
  if (!terms.length) return [];
  return docs().map((doc) => {
    let score = 0;
    for (const term of terms) {
      if (doc.title.toLowerCase().includes(term)) score += 8;
      let at = 0;
      while ((at = doc.lower.indexOf(term, at)) >= 0) { score += 1; at += term.length; }
    }
    return { doc, score };
  }).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.rel.localeCompare(b.doc.rel))
    .slice(0, Math.max(1, Math.min(Number(limit) || 5, 8)))
    .map(({ doc }) => ({ title: doc.title, manual_path: doc.rel.replace(/\.md$/, ''), excerpt: excerpt(doc, terms) }));
}

module.exports = { search, termsOf };
