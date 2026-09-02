// tests/firmConfigCoverage.test.js
//
/**
 * FIRM CONFIG COVERAGE GUARD — every cfg() key a reader names must be
 * registered (Unified Events U8 item 0; v0.5 §8.3 "Cross-arc firmConfig
 * hazard").
 *
 * ── THE FAILURE THIS PREVENTS ───────────────────────────────────────────────
 *
 * `lib/firmConfig.js` THROWS on an unregistered key:
 *
 *     if (!reg) throw new Error(`[firmConfig] unknown key "${key}" …`);
 *
 * That is the right design — a typo'd key is a bug, not a null — but it turns
 * the REGISTRY object into a cross-file contract that nothing checks. Commit
 * a2745f72 (another arc, "g3 g4") edited `firmConfig.js` from a pre-U6a copy
 * and silently dropped the `unified_singleton_enabled` registration. Nothing
 * failed at deploy: `cfg()` only throws when it is CALLED, and the one caller
 * — `eventService.createEvent` — reads the flag outside its try/catch, so
 * every event create would have 500'd post-commit (the row written, then the
 * throw). It survived only because nobody created an event in the exposure
 * window.
 *
 * The class fix is this file: a static scan asserting that every literal key
 * passed to cfg / cfgList / cfgJson in services/, lib/ and routes/ exists in
 * the registry. Whoever next rebases `firmConfig.js` from a stale copy gets a
 * red suite instead of a latent 500.
 *
 * ── WHY A STRING-AWARE SCAN RATHER THAN A REGEX ─────────────────────────────
 *
 * Same reason `tests/calendarEvents.registry.test.js` scans that way for
 * `extra:`. A bare /cfg\(['"]([^'"]+)/ matches inside comments and strings —
 * this tree has ~30 prose mentions of `cfg()` in header comments alone
 * (firmConfig.js's own docblock, documents.js's "the obvious alternative was
 * cfg()", court.js's "cfg() = email_automations setting…"). A loose regex
 * would either drag those in as phantom keys or need a denylist that rots.
 * So: walk the source skipping strings, templates and comments, and only then
 * look for a call token.
 *
 * Two directions, and only one of them is asserted:
 *
 *   used → registered   ASSERTED. An unregistered key is a runtime throw.
 *   registered → used   NOT asserted. An unused registry entry is inert (and
 *                       `internal_api_key_prev` spent a release that way, read
 *                       only by the rotation verifier). Failing on it would
 *                       punish pre-registration, which is the safe order.
 *
 * NOT SCANNED: `startup/`, `scripts/`, `public/`. The first two have no cfg()
 * readers today and the third is browser code that cannot have one. Widen
 * SCAN_DIRS if that changes — the found-count floor below will not notice.
 *
 * Run:  npx jest tests/firmConfigCoverage.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

const fs   = require('fs');
const path = require('path');
const { REGISTRY } = require('../lib/firmConfig');

const ROOT      = path.join(__dirname, '..');
const SCAN_DIRS = ['services', 'lib', 'routes'];

/** The three readers. All resolve through cfg(), so all three throw alike. */
const FNS = ['cfg', 'cfgList', 'cfgJson'];

/**
 * Call sites whose first argument is NOT a string literal. Every one is
 * inside firmConfig.js itself, forwarding its own already-validated `key`
 * parameter — there is nothing to check and nothing to register.
 *
 * Hand-maintained ON PURPOSE: a NEW dynamic cfg(someVar) anywhere is exactly
 * the thing this file cannot verify, so it must be a deliberate, reviewed
 * addition rather than a silent pass.
 */
const EXPECTED_DYNAMIC = [
  'lib/firmConfig.js:cfg(key)',   // inside cfgList()
  'lib/firmConfig.js:cfg(key)',   // inside cfgJson()
];

// ─────────────────────────────────────────────────────────────────────────────
// Scanner
// ─────────────────────────────────────────────────────────────────────────────

/** Index just past a string / template / comment starting at i, or -1. */
function _skip(src, i) {
  const c = src[i];
  if (c === "'" || c === '"' || c === '`') {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === c) return j + 1;
      j++;
    }
    return src.length;
  }
  if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); return n === -1 ? src.length : n; }
  if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i); return n === -1 ? src.length : n + 2; }
  return -1;
}

/** Text inside the balanced (...) whose '(' is at `open`, or null. */
function _balanced(src, open) {
  let depth = 0, i = open;
  while (i < src.length) {
    const s = _skip(src, i);
    if (s !== -1) { i = s; continue; }
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return src.slice(open + 1, i); }
    i++;
  }
  return null;
}

/** First top-level comma-separated argument of an arg list, trimmed. */
function _firstArg(args) {
  let depth = 0, i = 0;
  while (i < args.length) {
    const s = _skip(args, i);
    if (s !== -1) { i = s; continue; }
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return args.slice(0, i).trim();
    i++;
  }
  return args.trim();
}

/** A plain string literal → its value; anything else (incl. interpolation) → null. */
function _literal(arg) {
  const m = /^(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$\\]*)`)$/.exec(arg);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3];
  return raw.replace(/\\(.)/g, '$1');
}

const isWord = (c) => c != null && /[\w$]/.test(c);

/**
 * [{ file, fn, key, arg, line }] for every cfg / cfgList / cfgJson CALL in
 * `file`. Declarations (`function cfg(`) are skipped — they are the readers
 * themselves, not readers of a key.
 */
function scanCfgCalls(abs, rel) {
  const src = fs.readFileSync(abs, 'utf8');
  const out = [];
  let i = 0;
  while (i < src.length) {
    const s = _skip(src, i);
    if (s !== -1) { i = s; continue; }
    if (src[i] !== 'c' || isWord(src[i - 1])) { i++; continue; }

    // longest-first so cfgList / cfgJson win over the cfg prefix
    const fn = ['cfgList', 'cfgJson', 'cfg'].find((f) => src.startsWith(f, i) && !isWord(src[i + f.length]));
    if (!fn) { i++; continue; }

    let j = i + fn.length;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== '(') { i += fn.length; continue; }

    // `function cfg(` / `async function cfgJson(` is the declaration
    const before = src.slice(Math.max(0, i - 24), i);
    if (/\bfunction\s+$/.test(before)) { i = j + 1; continue; }

    const args = _balanced(src, j);
    if (args == null) { i = j + 1; continue; }
    const arg = _firstArg(args);
    out.push({
      file: rel, fn, arg,
      key:  _literal(arg),
      line: src.slice(0, i).split('\n').length,
    });
    i = j + 1;
  }
  return out;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      yield* walk(p);
    } else if (e.name.endsWith('.js')) {
      yield p;
    }
  }
}

const CALLS = SCAN_DIRS.flatMap((d) =>
  [...walk(path.join(ROOT, d))].flatMap((f) => scanCfgCalls(f, path.relative(ROOT, f).split(path.sep).join('/'))));

const LITERAL = CALLS.filter((c) => c.key != null);
const DYNAMIC = CALLS.filter((c) => c.key == null);

// ─────────────────────────────────────────────────────────────────────────────

describe('firmConfig registry coverage', () => {
  test('THE GUARD — every literal cfg key in services/ lib/ routes/ is registered', () => {
    const missing = LITERAL
      .filter((c) => !Object.prototype.hasOwnProperty.call(REGISTRY, c.key))
      .map((c) => `${c.file}:${c.line} ${c.fn}('${c.key}') — not in lib/firmConfig.js REGISTRY`);
    expect(missing).toEqual([]);
  });

  test('the flag U6b nearly lost is registered (the regression this file exists for)', () => {
    expect(REGISTRY).toHaveProperty('unified_singleton_enabled');
    // …and is really read by the singleton writer, so the guard has a subject.
    expect(LITERAL.some((c) => c.key === 'unified_singleton_enabled')).toBe(true);
  });

  test('every registry entry is a descriptor object (env / legacyEnv or empty)', () => {
    const bad = Object.entries(REGISTRY).filter(([, v]) =>
      v == null || typeof v !== 'object' || Array.isArray(v) ||
      Object.keys(v).some((k) => k !== 'env' && k !== 'legacyEnv'));
    expect(bad.map(([k]) => k)).toEqual([]);
  });
});

describe('the scan itself has not rotted', () => {
  test('it finds a realistic number of call sites across several files', () => {
    // ~40 literal reads across ~25 files today. A collapse to near-zero means
    // the walker or the token match broke, not that the codebase stopped
    // reading config.
    expect(LITERAL.length).toBeGreaterThanOrEqual(20);
    expect(new Set(LITERAL.map((c) => c.file)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(LITERAL.map((c) => c.key)).size).toBeGreaterThanOrEqual(10);
  });

  test('it reads all three readers, and both quote styles', () => {
    expect(new Set(LITERAL.map((c) => c.fn))).toEqual(new Set(FNS));
    // lib/auth.jwtOrApiKey.js and routes/logs.js use double quotes; most of
    // the tree uses single. A scanner that only saw one style would still
    // pass the count floor above.
    expect(LITERAL.some((c) => c.key === 'internal_api_key_prev')).toBe(true);
  });

  test('it ignores prose: the ~30 cfg() mentions in comments are not keys', () => {
    // firmConfig.js's own docblock says `cfg('email_it')`; documents.js and
    // court.js discuss cfg() at length. None of those lines is a call site.
    const fromFirmConfigDocblock = LITERAL.filter((c) => c.file === 'lib/firmConfig.js' && c.line < 50);
    expect(fromFirmConfigDocblock).toEqual([]);
    expect(LITERAL.every((c) => c.arg.startsWith("'") || c.arg.startsWith('"') || c.arg.startsWith('`'))).toBe(true);
  });

  test('dynamic-key call sites are exactly the expected (in-module forwarding) ones', () => {
    // A cfg(someVariable) added anywhere else is invisible to this guard, so
    // it has to be a reviewed addition rather than a silent pass.
    expect(DYNAMIC.map((c) => `${c.file}:${c.fn}(${c.arg})`).sort()).toEqual([...EXPECTED_DYNAMIC].sort());
  });
});
