// read_source — read or grep this deploy's own source (Casey v2 S1, design
// §4.1, ruling 9: open to all staff). The Dockerfile `COPY . .`s the repo, so
// the files that serve a request are the files Casey reads: a route's body
// and response shape are learned the way Claude learns them in chat.
//
// Confinement — resolved REAL paths only, never the string:
//   • the path is relative, '/'-separated, no empty / '.' / '..' segment, no
//     segment starting with '.' (no .env, .git, .githooks), no NUL/backslash;
//   • its first segment must be one of DIRS (routes services lib public manual
//     ref — not scripts/, startup/, tests/, local/, node_modules/);
//   • path.resolve + fs.realpath, then the real path must still sit under the
//     real root's DIRS — a symlink planted inside an allowed dir that points
//     outside fails here, whatever its name says;
//   • `ctx.sourceRoot` overrides the repo root (tests build a tree in a temp dir).
// Caps: a read returns ≤ MAX_LINES lines / ≤ MAX_BYTES; grep is a plain,
// case-insensitive SUBSTRING (no regex from the model — a supplied regex over
// the whole tree is a ReDoS handle), ≤ MAX_HITS hits, skipping binaries (NUL in
// the first 8 KB) and files over 2 MB, bounded by a SCAN_BUDGET of bytes read
// (a miss over all six dirs reads ~27 MB and fits; a tree that outgrows the
// budget is cut and says `truncated` — then `dir` narrows the search). The scan is asynchronous and yields to the event loop
// every YIELD_EVERY files (fs.promises), so a grep never stalls the process
// that is also acking webhooks — S1 review measured a 235 ms sync stall.
'use strict';

const fs = require('fs');
const path = require('path');
const { ToolError } = require('./index_error');

const DIRS = Object.freeze(['routes', 'services', 'lib', 'public', 'manual', 'ref']);
const MAX_LINES = 400;
const MAX_BYTES = 40 * 1024;
const MAX_HITS = 50;
const MAX_FILE = 2 * 1024 * 1024;
const SCAN_BUDGET = 32 * 1024 * 1024; // the six dirs hold ~27 MB of text (2026-11); a whole-tree miss fits
const YIELD_EVERY = 25;
// Not worth opening: skipped by name before any read, outside the budget.
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|eot|pdf|wav|mp3|mp4|webm|ogg|zip|gz|tgz|bz2|7z|jar|wasm|map)$/i;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function rootOf(ctx) {
  return path.resolve(ctx && ctx.sourceRoot ? ctx.sourceRoot : REPO_ROOT);
}

/** Relative path → { rel, abs } inside an allowed dir, or a ToolError('BAD_PATH'). */
function confine(ctx, raw, { mustBeFile = true } = {}) {
  const rel = String(raw || '');
  // eslint-disable-next-line no-control-regex
  if (!rel || /[\x00\\]/.test(rel) || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw new ToolError('BAD_PATH', 'path must be relative, like routes/api.tasks.js');
  const segs = rel.split('/');
  for (const s of segs) {
    if (!s || s === '.' || s === '..') throw new ToolError('BAD_PATH', 'path has an empty, . or .. segment');
    if (s.startsWith('.')) throw new ToolError('BAD_PATH', 'dotfiles and dot-directories are not readable');
  }
  if (!DIRS.includes(segs[0])) throw new ToolError('BAD_PATH', `path must start with one of ${DIRS.join(', ')}`);
  const root = rootOf(ctx);
  const abs = path.resolve(root, rel);
  let realRoot, real;
  try { realRoot = fs.realpathSync(root); real = fs.realpathSync(abs); }
  catch (e) { throw new ToolError(e.code === 'ENOENT' ? 'NOT_FOUND' : 'BAD_PATH', e.code === 'ENOENT' ? `no such file: ${rel}` : `cannot resolve ${rel}`); }
  const allowedPrefixes = DIRS.map((d) => path.join(realRoot, d));
  const inside = allowedPrefixes.some((pre) => real === pre || real.startsWith(pre + path.sep));
  if (!inside) throw new ToolError('BAD_PATH', `${rel} resolves outside the readable directories`);
  // Every segment of the REAL path under the root must also be dot-free: a
  // symlink to .git/… inside an allowed dir is caught by this, not by the name.
  if (path.relative(realRoot, real).split(path.sep).some((s) => s.startsWith('.'))) throw new ToolError('BAD_PATH', 'resolves into a dot-directory');
  const st = fs.statSync(real);
  if (mustBeFile && !st.isFile()) throw new ToolError('BAD_PATH', `${rel} is not a file`);
  if (!mustBeFile && !st.isDirectory()) throw new ToolError('BAD_PATH', `${rel} is not a directory`);
  return { rel, abs: real, size: st.size };
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function readLines(ctx, input) {
  const { rel, abs, size } = confine(ctx, input.path);
  if (size > MAX_FILE) throw new ToolError('TOO_LARGE', `${rel} is ${size} bytes; grep it instead`);
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) throw new ToolError('BINARY', `${rel} is not a text file`);
  const all = buf.toString('utf8').split('\n');
  const start = Math.max(1, input.start || 1);
  const want = Math.min(MAX_LINES, input.lines || MAX_LINES);
  const out = [];
  let bytes = 0;
  let i = start - 1;
  for (; i < all.length && out.length < want; i++) {
    const line = all[i];
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    if (bytes > MAX_BYTES && out.length) break;
    out.push(line);
  }
  const end = start + out.length - 1;
  return { path: rel, total_lines: all.length, start, end, truncated: end < all.length, text: out.join('\n') };
}

/** Every regular file under `dir` (sorted, recursive), as [path, size]. A
 *  Dirent reports the entry's OWN type: a symlink is neither a directory nor a
 *  file here, so the walk never follows a link (the grep test plants one to a
 *  directory outside and one to a file outside). Dot entries and node_modules
 *  are skipped. */
async function listFiles(dir, out) {
  const ents = (await fs.promises.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of ents) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { await listFiles(full, out); continue; }
    if (!ent.isFile() || BINARY_EXT.test(ent.name)) continue;
    const st = await fs.promises.stat(full);
    if (st.size <= MAX_FILE) out.push([full, st.size]);
  }
  return out;
}

const yieldLoop = () => new Promise((r) => setImmediate(r));

async function grep(ctx, input) {
  const needle = String(input.grep);
  const lower = needle.toLowerCase();
  const root = fs.realpathSync(rootOf(ctx));
  const dirs = input.dir ? [confine(ctx, input.dir, { mustBeFile: false }).abs] : DIRS.map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
  const files = [];
  for (const d of dirs) await listFiles(d, files);
  const hits = [];
  let spent = 0, scanned = 0, exhausted = false;
  outer: for (const [file, size] of files) {
    if (spent + size > SCAN_BUDGET) { exhausted = true; break; }
    spent += size;
    scanned++;
    if (scanned % YIELD_EVERY === 0) await yieldLoop();
    const buf = await fs.promises.readFile(file);
    if (isBinary(buf)) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(lower)) continue;
      hits.push({ path: path.relative(root, file).split(path.sep).join('/'), line: i + 1, text: lines[i].length > 300 ? `${lines[i].slice(0, 300)}…` : lines[i] });
      if (hits.length >= MAX_HITS) break outer;
    }
  }
  return { grep: needle, dir: input.dir || null, files_scanned: scanned, files_total: files.length, hits, truncated: hits.length >= MAX_HITS || exhausted };
}

module.exports = {
  name: 'read_source',
  description: `Read this deploy's own source code and docs. Either { path, start?, lines? } to read up to ${MAX_LINES} lines of one file (routes/, services/, lib/, public/, manual/, ref/ — e.g. routes/api.tasks.js, ref/database.sql, manual/…), or { grep, dir? } for a case-insensitive substring search returning up to ${MAX_HITS} hits with line numbers (pass dir to narrow it; a result marked truncated did not reach every file). Use it to learn a route's body, validation and response before calling or proposing it.`,
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 400, description: 'Relative file path to read.' },
      start: { type: 'integer', minimum: 1, maximum: 1000000, description: 'First line (1-based, default 1).' },
      lines: { type: 'integer', minimum: 1, maximum: MAX_LINES, description: `Line count (default and max ${MAX_LINES}).` },
      grep: { type: 'string', minLength: 2, maxLength: 200, description: 'Substring to search for (case-insensitive, not a regex).' },
      dir: { type: 'string', minLength: 1, maxLength: 400, description: 'Restrict grep to this relative directory.' },
    },
    required: [],
  },
  untrusted: true,
  async run(ctx, input) {
    if (input.grep != null && input.path != null) throw new ToolError('BAD_INPUT', 'give either path or grep, not both');
    if (input.grep != null) return grep(ctx, input);
    if (input.path != null) return readLines(ctx, input);
    throw new ToolError('BAD_INPUT', 'give path (to read) or grep (to search)');
  },
  DIRS, MAX_LINES, MAX_BYTES, MAX_HITS, SCAN_BUDGET,
};
