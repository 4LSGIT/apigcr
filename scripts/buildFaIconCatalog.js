// scripts/buildFaIconCatalog.js
//
/**
 * Builds the icon picker's catalog (public/js/ycIconPicker.js) from Font
 * Awesome Free's own package metadata — ui-custom S6a.
 *
 *   node scripts/buildFaIconCatalog.js <icon-families.json> [--version X.Y.Z] [--out <file>] [--check]
 *
 * Getting the input (the package is UNTRUSTED DATA: parse its JSON, never run
 * anything from it — no `npm install`, no scripts):
 *
 *   mkdir /tmp/fa && cd /tmp/fa
 *   npm pack @fortawesome/fontawesome-free@6.5.0 --ignore-scripts
 *   tar -xzf fortawesome-fontawesome-free-6.5.0.tgz package/metadata/icon-families.json package/package.json
 *   node <repo>/scripts/buildFaIconCatalog.js /tmp/fa/package/metadata/icon-families.json
 *
 * The version comes from --version, else from the package.json two levels up
 * from the input (package/package.json). The output defaults to
 * public/js/faIcons-<version>.json. A new FA version is a new catalog file:
 * bump the stylesheet link in public/index.html (and the panes that link it)
 * and CATALOG_URL in public/js/ycIconPicker.js in the same commit.
 * --check builds and compares with the file on disk (exit 1 when they differ),
 * writing nothing.
 *
 * Output — compact, no SVG paths, one icon per line so a version bump diffs
 * readably:
 *   { "version": "6.5.0", "source": "...", "generated_by": "...",
 *     "icons": [ [name, families, terms?], … ] }   sorted by name
 *   name      the FA icon name (fa-<name>); it must match ^[a-z0-9-]{1,40}$ —
 *             the bare slug of the stored icon grammar (public/js/ycIcon.js) —
 *             or the build FAILS: a catalog name the grammar refuses could be
 *             offered and then never saved
 *   families  the families it is FREE in, as letters in this order: s(olid)
 *             r(egular) b(rands) — e.g. "s", "sr", "b"
 *   terms     the search terms and the old alias names (FA 5's "home" for
 *             house), lower case, de-duplicated, space-joined; left out when
 *             there are none. Search only: never rendered as markup.
 * Only the "classic" family's solid / regular / brands styles are free in FA
 * 6 Free; any other free style the metadata names is skipped (and counted).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const NAME_RE = /^[a-z0-9-]{1,40}$/;
const STYLES = [['solid', 's'], ['regular', 'r'], ['brands', 'b']];
const TERM_MAX = 40;

/** families JSON (parsed icon-families.json) → { catalog, skipped }. Pure. */
function build(families, version) {
  if (!families || typeof families !== 'object' || Array.isArray(families)) throw new Error('icon-families.json: not an object');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`bad version ${JSON.stringify(version)}`);
  const icons = [];
  let skipped = 0;
  for (const name of Object.keys(families).sort()) {
    const meta = families[name];
    const free = meta && meta.familyStylesByLicense && Array.isArray(meta.familyStylesByLicense.free)
      ? meta.familyStylesByLicense.free : [];
    const styles = new Set();
    for (const fs_ of free) {
      if (fs_ && fs_.family === 'classic' && STYLES.some(([s]) => s === fs_.style)) styles.add(fs_.style);
      else skipped++;
    }
    if (!styles.size) continue;
    if (!NAME_RE.test(name)) throw new Error(`icon name ${JSON.stringify(name)} does not match ${NAME_RE}`);
    const fam = STYLES.filter(([s]) => styles.has(s)).map(([, l]) => l).join('');
    const terms = new Set();
    const add = (t) => {
      if (typeof t !== 'string' && typeof t !== 'number') return;
      const s = String(t).toLowerCase().split(/\s+/).filter(Boolean).join(' ').slice(0, TERM_MAX).trim();
      if (s && s !== name) terms.add(s);
    };
    ((meta.search && meta.search.terms) || []).forEach(add);
    ((meta.aliases && meta.aliases.names) || []).forEach(add);
    icons.push(terms.size ? [name, fam, [...terms].join(' ')] : [name, fam]);
  }
  if (!icons.length) throw new Error('no free icons found');
  return {
    catalog: {
      version,
      source: `@fortawesome/fontawesome-free@${version} metadata/icon-families.json`,
      generated_by: 'scripts/buildFaIconCatalog.js',
      icons,
    },
    skipped,
  };
}

/** The catalog as written: one icon per line. */
function serialize(catalog) {
  const head = { version: catalog.version, source: catalog.source, generated_by: catalog.generated_by };
  const top = JSON.stringify(head).slice(0, -1);
  return `${top},"icons":[\n${catalog.icons.map((i) => JSON.stringify(i)).join(',\n')}\n]}\n`;
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const check = args.includes('--check');
  if (check) args.splice(args.indexOf('--check'), 1);
  let version = opt('--version');
  let out = opt('--out');
  const input = args[0];
  if (!input || args.length !== 1) {
    console.error('usage: node scripts/buildFaIconCatalog.js <icon-families.json> [--version X.Y.Z] [--out <file>] [--check]');
    return 2;
  }
  if (!version) {
    const pj = path.join(path.dirname(input), '..', 'package.json');
    try { version = JSON.parse(fs.readFileSync(pj, 'utf8')).version; } catch (_) { /* below */ }
    if (!version) { console.error(`no --version and no readable ${pj}`); return 2; }
  }
  const { catalog, skipped } = build(JSON.parse(fs.readFileSync(input, 'utf8')), version);
  out = out || path.join(__dirname, '..', 'public', 'js', `faIcons-${version}.json`);
  const text = serialize(catalog);
  const n = { s: 0, r: 0, b: 0 };
  catalog.icons.forEach(([, f]) => { for (const c of f) n[c]++; });
  const summary = `${catalog.icons.length} icons (solid ${n.s}, regular ${n.r}, brands ${n.b}; ${n.s + n.r + n.b} tiles), ${Buffer.byteLength(text)} bytes` +
    (skipped ? `, ${skipped} non-classic free styles skipped` : '');
  if (check) {
    let cur = null;
    try { cur = fs.readFileSync(out, 'utf8'); } catch (_) { /* missing */ }
    if (cur === text) { console.log(`OK ${out} is current: ${summary}`); return 0; }
    console.error(`DRIFT ${out} differs from a fresh build (${summary})`);
    return 1;
  }
  fs.writeFileSync(out, text);
  console.log(`wrote ${out}: ${summary}`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv));

module.exports = { build, serialize, NAME_RE };
