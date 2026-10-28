// tests/settingsInventory.test.js
//
/**
 * SETTINGS INVENTORY — the code and lib/settingsRegistry.js agree on which
 * app_settings keys exist (settings arc, 2026-10-17).
 *
 * The registry is the one list of keys the code knows; the editors, the
 * automation guards (set_setting / update_db) and the settings API all decide
 * from it. A key the code reads but the registry lacks would be an
 * "automation variable" to every one of them — editable by any firm.settings
 * holder through the variables section, writable by automation. A registry
 * entry nothing reads is a stale promise in an editor. Three directions:
 *
 *   (a) FORWARD — every key SERVER code reads (lib/, services/, routes/,
 *       startup/, server.js; not tests/, scripts/ or public/) is registered,
 *       or sits in ALLOW below with a reason. No server code reads a RETIRED
 *       key. The idioms recognised:
 *         · reader calls — getSetting / _getSetting (any local copy of the
 *           name) / getSettings / cfg / cfgJson / cfgList — whose argument is
 *           a literal, an array of literals, Object.values(X), a constant
 *           named *KEY* / *SETTING* (resolved in the file, then across the
 *           scanned tree: esignWebhookService.X_KEY; an object map → all its
 *           values: ctaService SETTING_TIMEOUT[mode], the comms sweeps'
 *           getSettings(db, Object.values(KEYS))), or a local alias of one
 *           (portal.branding's `const keys = Object.values(BRANDING_KEYS)`);
 *         · SQL text naming app_settings — `key` = 'k', `key` [NOT] IN
 *           ('a', 'b'), INSERT … VALUES ('k', …), CASE `key` WHEN 'k' — with
 *           adjacent literals joined across `+` first; the same resolution
 *           over that query's params argument when the SQL binds the key
 *           (`key` = ? / IN (?, …)); and `key` LIKE 'p%' as a class read of
 *           every live registered key under the prefix (api.firmData's fe-%);
 *         · single-string constants named *KEY* / *SETTING* (UPPER_CASE)
 *           anywhere in server code — a key handed to a helper that reads it
 *           (documentGenerateService UNSORTED_PATH_KEY → filePlacementService).
 *           Object maps / arrays count only when a reader or a query USES
 *           them, so a *_KEYS map of body fields or event keys is not a read.
 *       A key-shaped string: snake_case with an underscore, or fe-*.
 *       Coverage: every registered, non-retired key is either FOUND by the
 *       scan or listed in SCAN_BLIND with why the scan cannot see it — both
 *       lists exact, so a new reader idiom or a dropped reader shows up here.
 *   (b) REVERSE — every registered key whose kind is not 'retired' appears as
 *       a quoted literal in server code (comments excluded) or in public/
 *       (fe-* keys: client-side also as the stripped name, quoted or as
 *       `settings.<name>`), or sits in EXEMPT with a reason.
 *       lib/settingsRegistry.js itself is not evidence.
 *   (c) lib/firmConfig.js — every REGISTRY key is registered with the SAME
 *       env fallback, and every registry entry naming an env is a firmConfig
 *       key (the env column documents firmConfig's fallback, nothing else).
 *
 * The scanner is string-, template-, comment- and regex-literal-aware (the
 * tests/firmConfigCoverage.test.js approach): prose in comments is never a
 * key, and a quote inside a regex literal never opens a string.
 *
 * Run: npx jest tests/settingsInventory.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const registry = require('../lib/settingsRegistry');
const { REGISTRY: FIRM_CONFIG } = require('../lib/firmConfig');

const ROOT = path.join(__dirname, '..');
const SERVER_DIRS = ['lib', 'services', 'routes', 'startup'];
const SERVER_FILES = ['server.js'];
const REGISTRY_FILE = 'lib/settingsRegistry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Reviewed lists — each entry is a deliberate, commented decision. Stale
// entries fail (see the tests), so these cannot rot quietly.
// ─────────────────────────────────────────────────────────────────────────────

/** (a) Found by the forward scan but NOT app_settings keys. */
const ALLOW = {
  // services/commsSummarizeSweep.js PROMPT_KEY — the ai prompt-template key
  // the summaries render through, not an app_settings row. Its name matches
  // the constant idiom; nothing reads it from app_settings.
  comms_summary: 'ai prompt key (commsSummarizeSweep PROMPT_KEY), not a setting',
};

/** (a) coverage — registered, non-retired keys the forward scan cannot see, and why. */
const SCAN_BLIND = {
  // Nothing reads it: the Calendly hooks verify signatures with the per-hook
  // secret in hooks.auth_config (services/hookService.js — "org copy:
  // app_settings.calendly_webhook_signing_key"); the row is the record of a
  // secret the provider never shows again.
  calendly_webhook_signing_key: 'stored for the record only — no code reads it',
  // Nothing reads it since services/quoService.js was deleted (2026-10-28): the
  // Quo phone driver authenticates through its Connections credential. Stays a
  // registered secret until its row is deleted.
  quo_api_key: 'no code reads it — the phone driver uses its Connections credential',
  // Read only by an automation definition: the payment-failed workflow's
  // get_settings step (registered 2026-10-28; was an automation variable).
  payment_failed_cooldown_days: 'read by the payment-failed workflow, not by code',
};

/** (b) Registered, non-retired keys with no quoted literal anywhere, and why. */
const EXEMPT = {
  calendly_webhook_signing_key: 'stored for the record only — no code reads it (see SCAN_BLIND)',
  quo_api_key: 'no code reads it since services/quoService.js was deleted (2026-10-28); the phone driver uses its Connections credential',
  payment_failed_cooldown_days: 'read by the payment-failed workflow (get_settings), not by code',
};

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer — strings, templates, comments, regex literals.
// ─────────────────────────────────────────────────────────────────────────────

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[\w$]/;
// After these a '/' starts a regex literal, not a division.
const REGEX_AFTER_KW = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await']);

/** Index just past the string / template starting at i (quote char at src[i]). */
function skipQuoted(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      j = skipBraces(src, j + 1);
      continue;
    }
    if (c === q) return j + 1;
    if (q !== '`' && c === '\n') return j;        // unterminated: stop at EOL
    j++;
  }
  return src.length;
}

/** src[i] === '{' → index just past its matching '}' (strings / comments inside skipped). */
function skipBraces(src, i) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { j = skipQuoted(src, j); continue; }
    if (c === '/' && src[j + 1] === '/') { const n = src.indexOf('\n', j); j = n === -1 ? src.length : n; continue; }
    if (c === '/' && src[j + 1] === '*') { const n = src.indexOf('*/', j + 2); j = n === -1 ? src.length : n + 2; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return src.length;
}

function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return j;
    if (inClass) { if (c === ']') inClass = false; }
    else if (c === '[') inClass = true;
    else if (c === '/') { j++; while (j < src.length && /[a-z]/i.test(src[j])) j++; return j; }
    j++;
  }
  return src.length;
}

/**
 * tokens: { t: 'str'|'tpl'|'id'|'num'|'p'|'re', v, start, end }
 * str.v = the cooked-enough content (escapes reduced to their char);
 * tpl.v = the raw text between the backticks, ${…} included.
 * Also returns `code`: src with every comment replaced by spaces.
 */
function tokenize(src) {
  const toks = [];
  const code = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (code[k] !== '\n') code[k] = ' '; };
  let i = 0;
  const prevSig = () => toks[toks.length - 1];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); const e = n === -1 ? src.length : n; blank(i, e); i = e; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); const e = n === -1 ? src.length : n + 2; blank(i, e); i = e; continue; }
    if (c === "'" || c === '"') {
      const e = skipQuoted(src, i);
      const raw = src.slice(i + 1, e - 1);
      toks.push({ t: 'str', v: raw.replace(/\\(.)/g, '$1'), start: i, end: e });
      i = e; continue;
    }
    if (c === '`') {
      const e = skipQuoted(src, i);
      toks.push({ t: 'tpl', v: src.slice(i + 1, e - 1), start: i, end: e });
      i = e; continue;
    }
    if (c === '/') {
      const p = prevSig();
      const regexOk = !p || (p.t === 'p' && !/[)\]}]/.test(p.v)) || (p.t === 'id' && REGEX_AFTER_KW.has(p.v));
      if (regexOk) { const e = skipRegex(src, i); toks.push({ t: 're', v: src.slice(i, e), start: i, end: e }); i = e; continue; }
      toks.push({ t: 'p', v: c, start: i, end: i + 1 }); i++; continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), start: i, end: j });
      i = j; continue;
    }
    if (/\d/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w.]/.test(src[j])) j++;
      toks.push({ t: 'num', v: src.slice(i, j), start: i, end: j });
      i = j; continue;
    }
    toks.push({ t: 'p', v: c, start: i, end: i + 1 });
    i++;
  }
  return { toks, code: code.join('') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction
// ─────────────────────────────────────────────────────────────────────────────

const KEY_SHAPE = /^(?:fe-[a-z][a-z0-9_]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/;
const isKeyShaped = (s) => typeof s === 'string' && KEY_SHAPE.test(s);
const READERS = new Set(['getSetting', '_getSetting', 'getSettings', 'cfg', 'cfgJson', 'cfgList']);
const CONST_NAME = /^(?=[A-Z])[A-Z0-9_]*(?:KEY|SETTING)[A-Z0-9_]*$/;

/** Index of the token closing the bracket opened at toks[i] (( [ {), or -1. */
function matchClose(toks, i) {
  const open = toks[i].v;
  const close = { '(': ')', '[': ']', '{': '}' }[open];
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].t !== 'p') continue;
    if (toks[j].v === open) depth++;
    else if (toks[j].v === close) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** Split toks[a..b) at top-level commas → arrays of tokens. */
function splitTop(toks, a, b) {
  const out = [];
  let cur = [];
  let depth = 0;
  for (let j = a; j < b; j++) {
    const t = toks[j];
    if (t.t === 'p' && '([{'.includes(t.v)) depth++;
    if (t.t === 'p' && ')]}'.includes(t.v)) depth--;
    if (t.t === 'p' && t.v === ',' && depth === 0) { out.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Literal string values of an object / array literal toks[i..close] (one level of nesting). */
function literalValues(toks, i) {
  const close = matchClose(toks, i);
  if (close === -1) return [];
  const vals = [];
  for (const part of splitTop(toks, i + 1, close)) {
    // { name: 'v' } → the value side; [ 'v' ] → the element
    const colon = part.findIndex((t) => t.t === 'p' && t.v === ':');
    const valueToks = colon === -1 ? part : part.slice(colon + 1);
    if (valueToks.length === 1 && valueToks[0].t === 'str') vals.push(valueToks[0].v);
  }
  return vals;
}

/**
 * File-level declarations:
 *   consts  — NAME contains KEY / SETTING: name → { values, single } (a
 *             string → single:true; an object map / array, or Object.freeze
 *             of either → its literal values, single:false);
 *   aliases — any `const|let|var name = <rhs>;` → the rhs tokens, so a local
 *             like `const keys = Object.values(BRANDING_KEYS)` resolves.
 */
function declarationsOf(toks) {
  const consts = new Map();
  const aliases = new Map();
  for (let i = 0; i + 3 < toks.length; i++) {
    const kw = toks[i];
    if (kw.t !== 'id' || !['const', 'let', 'var'].includes(kw.v)) continue;
    const name = toks[i + 1];
    if (name.t !== 'id' || !(toks[i + 2].t === 'p' && toks[i + 2].v === '=')) continue;
    // alias rhs: up to the first top-level ';' (bounded)
    let depth = 0;
    let e = i + 3;
    for (; e < toks.length && e < i + 3 + 40; e++) {
      const t = toks[e];
      if (t.t === 'p' && '([{'.includes(t.v)) depth++;
      if (t.t === 'p' && ')]}'.includes(t.v)) depth--;
      if (depth === 0 && t.t === 'p' && t.v === ';') break;
    }
    if (!aliases.has(name.v)) aliases.set(name.v, toks.slice(i + 3, e));
    if (!CONST_NAME.test(name.v)) continue;
    let k = i + 3;
    if (toks[k].t === 'id' && toks[k].v === 'Object' && toks[k + 2] && toks[k + 2].v === 'freeze'
        && toks[k + 3] && toks[k + 3].v === '(') k += 4;
    const rhs = toks[k];
    if (!rhs) continue;
    if (rhs.t === 'str') consts.set(name.v, { values: [rhs.v], single: true });
    else if (rhs.t === 'p' && (rhs.v === '{' || rhs.v === '[')) consts.set(name.v, { values: literalValues(toks, k), single: false });
  }
  return { consts, aliases };
}

/** Text of a run of string / template tokens joined by '+', starting at toks[i]. */
function joinedText(toks, i) {
  let text = '';
  let j = i;
  while (j < toks.length && (toks[j].t === 'str' || toks[j].t === 'tpl')) {
    text += toks[j].v;
    if (toks[j + 1] && toks[j + 1].t === 'p' && toks[j + 1].v === '+'
        && toks[j + 2] && (toks[j + 2].t === 'str' || toks[j + 2].t === 'tpl')) { j += 2; continue; }
    break;
  }
  return { text, next: j + 1 };
}

const QUOTED = /['"]([^'"]+)['"]/g;
const quotedIn = (s) => [...s.matchAll(QUOTED)].map((m) => m[1]);

/**
 * Literal keys named by SQL text that mentions app_settings; a `key` LIKE
 * pattern comes back as { prefix }.
 */
function sqlKeys(text) {
  if (!/app_settings/i.test(text)) return [];
  const keys = [];
  const t = text.replace(/\\?`/g, '');           // identifier quotes, escaped inside templates too
  for (const m of t.matchAll(/\bkey\s+LIKE\s+['"]([^'"%_]+)%['"]/gi)) keys.push({ prefix: m[1] });
  for (const m of t.matchAll(/\bkey\s*=\s*['"]([^'"]+)['"]/gi)) keys.push(m[1]);
  for (const m of t.matchAll(/\bkey\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi)) keys.push(...quotedIn(m[1]));
  for (const m of t.matchAll(/INSERT\s+INTO\s+app_settings\s*\([^)]*\)\s*VALUES\s*\(\s*['"]([^'"]+)['"]/gi)) keys.push(m[1]);
  if (/CASE\s+key\b/i.test(t)) for (const m of t.matchAll(/WHEN\s+['"]([^'"]+)['"]\s+THEN/gi)) keys.push(m[1]);
  return keys;
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* walk(p); }
    else yield p;
  }
}
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

const SERVER = [
  ...SERVER_DIRS.flatMap((d) => [...walk(path.join(ROOT, d))].filter((f) => f.endsWith('.js'))),
  ...SERVER_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
].map((abs) => {
  const src = fs.readFileSync(abs, 'utf8');
  const { toks, code } = tokenize(src);
  return { file: rel(abs), src, toks, code, ...declarationsOf(toks) };
});

// Constants across the tree, for member-expression resolution (svc.X_KEY).
const GLOBAL_CONSTS = new Map();
for (const f of SERVER) for (const [k, v] of f.consts) {
  if (!GLOBAL_CONSTS.has(k)) GLOBAL_CONSTS.set(k, []);
  GLOBAL_CONSTS.get(k).push(v);
}

/**
 * Resolve an argument (token list) to key strings; null when dynamic.
 * Literals, arrays of them, Object.values(X), a KEY/SETTING constant (file,
 * then tree: svc.X_KEY; an object map → all its values, X[expr] too), and a
 * local alias of any of those (two hops at most).
 */
function resolveArg(f, part, hops = 0) {
  if (!part.length) return null;
  if (part.length === 1 && part[0].t === 'str') return [part[0].v];
  if (part.length === 1 && part[0].t === 'tpl' && !part[0].v.includes('${')) return [part[0].v];
  if (part[0].t === 'p' && part[0].v === '[') {
    const close = matchClose(part, 0);
    if (close === part.length - 1) {
      const out = [];
      for (const el of splitTop(part, 1, close)) { const r = resolveArg(f, el, hops); if (r) out.push(...r); }
      return out;
    }
  }
  if (part.length >= 5 && part[0].v === 'Object' && part[1].v === '.' && part[2].v === 'values'
      && part[3].v === '(' && matchClose(part, 3) === part.length - 1) {
    return resolveArg(f, part.slice(4, part.length - 1), hops);
  }
  if (part.length === 1 && part[0].t === 'id' && !CONST_NAME.test(part[0].v) && hops < 2
      && f.aliases.has(part[0].v)) {
    return resolveArg(f, f.aliases.get(part[0].v), hops + 1);
  }
  // identifier, member chain (a.b.C), or X[expr] on an object-map constant
  const ids = [];
  for (let j = 0; j < part.length; j++) {
    const t = part[j];
    if (t.t === 'id') { ids.push(t.v); continue; }
    if (t.t === 'p' && t.v === '.') continue;
    if (t.t === 'p' && t.v === '[') { const c = matchClose(part, j); if (c === -1) return null; j = c; continue; }
    return null;
  }
  for (const name of [...ids].reverse()) {
    if (f.consts.has(name)) return f.consts.get(name).values;
    if (CONST_NAME.test(name) && GLOBAL_CONSTS.has(name)) return GLOBAL_CONSTS.get(name).flatMap((c) => c.values);
  }
  return null;
}

/** { key → Set(source) } from the forward idioms. */
function forwardScan() {
  const found = new Map();
  const add = (key, where) => {
    if (key && typeof key === 'object' && key.prefix) {
      // A LIKE class read (routes/api.firmData.js `key` LIKE 'fe-%') reads
      // every LIVE registered key under the prefix; it names no retired one.
      for (const [k, e] of Object.entries(registry.SETTINGS)) {
        if (k.startsWith(key.prefix) && e.kind !== 'retired') add(k, `${where} LIKE '${key.prefix}%'`);
      }
      return;
    }
    if (!isKeyShaped(key)) return;
    if (!found.has(key)) found.set(key, new Set());
    found.get(key).add(where);
  };
  for (const f of SERVER) {
    if (f.file === REGISTRY_FILE) continue;
    const { toks } = f;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      // reader calls
      if (t.t === 'id' && READERS.has(t.v) && toks[i + 1] && toks[i + 1].t === 'p' && toks[i + 1].v === '('
          && !(toks[i - 1] && toks[i - 1].t === 'id' && toks[i - 1].v === 'function')) {
        const close = matchClose(toks, i + 1);
        if (close !== -1) {
          for (const part of splitTop(toks, i + 2, close)) {
            const r = resolveArg(f, part);
            if (r) for (const k of r) add(k, `${f.file} ${t.v}()`);
          }
        }
      }
      // SQL text (adjacent literals joined across +)
      if ((t.t === 'str' || t.t === 'tpl') && !(toks[i - 1] && toks[i - 1].t === 'p' && toks[i - 1].v === '+'
          && toks[i - 2] && (toks[i - 2].t === 'str' || toks[i - 2].t === 'tpl'))) {
        const { text, next } = joinedText(toks, i);
        for (const k of sqlKeys(text)) add(k, `${f.file} SQL`);
        // …and that query's params argument, when the SQL binds the key:
        // `key` = ? / IN (?, …) — the argument after the SQL, to the next
        // top-level ',' or ')'.
        if (/app_settings/i.test(text) && /\bkey\W*\s*(=|IN)\s*\(?\s*\?/i.test(text.replace(/\\?`/g, ''))
            && toks[next] && toks[next].t === 'p' && toks[next].v === ',') {
          let depth = 0;
          let e = next + 1;
          for (; e < toks.length; e++) {
            const x = toks[e];
            if (x.t === 'p' && '([{'.includes(x.v)) depth++;
            if (x.t === 'p' && ')]}'.includes(x.v)) { if (depth === 0) break; depth--; }
            if (depth === 0 && x.t === 'p' && x.v === ',') break;
          }
          const r = resolveArg(f, toks.slice(next + 1, e));
          if (r) for (const k of r) add(k, `${f.file} SQL params`);
        }
      }
    }
    // single-string constants named *KEY* / *SETTING* (a key handed to a
    // helper that reads it: documentGenerateService → filePlacementService).
    // Object maps / arrays count only when a reader or a query USES them.
    for (const [name, c] of f.consts) if (c.single) for (const v of c.values) add(v, `${f.file} const ${name}`);
  }
  return found;
}

const FOUND = forwardScan();
const SETTINGS = registry.SETTINGS;
const LIVE_KEYS = Object.keys(SETTINGS).filter((k) => SETTINGS[k].kind !== 'retired');

// ─────────────────────────────────────────────────────────────────────────────
// (a) FORWARD
// ─────────────────────────────────────────────────────────────────────────────

describe('(a) forward — every key server code reads is registered', () => {
  test('THE GUARD — no unregistered key outside ALLOW', () => {
    const bad = [...FOUND.keys()]
      .filter((k) => !registry.isRegistered(k) && !Object.prototype.hasOwnProperty.call(ALLOW, k))
      .map((k) => `${k} ← ${[...FOUND.get(k)].join(', ')}`);
    expect(bad).toEqual([]);
  });

  test('no server code reads a RETIRED key', () => {
    const bad = [...FOUND.keys()].filter((k) => registry.get(k) && registry.get(k).kind === 'retired')
      .map((k) => `${k} ← ${[...FOUND.get(k)].join(', ')}`);
    expect(bad).toEqual([]);
  });

  test('ALLOW holds no stale or registered entry (each is found, none registered)', () => {
    for (const k of Object.keys(ALLOW)) {
      expect({ k, found: FOUND.has(k), registered: registry.isRegistered(k) }).toEqual({ k, found: true, registered: false });
    }
  });

  test('coverage — every live registered key is found by the scan or listed in SCAN_BLIND, exactly', () => {
    const notFound = LIVE_KEYS.filter((k) => !FOUND.has(k)).sort();
    expect(notFound).toEqual(Object.keys(SCAN_BLIND).sort());
  });
});

describe('the forward scan has not rotted', () => {
  test('each idiom still finds its known subject', () => {
    const via = (k, re) => FOUND.has(k) && [...FOUND.get(k)].some((s) => re.test(s));
    expect(via('portal_live', /lib\/auth\.requireAuth\.js (getSetting\(\)|const PORTAL_LIVE_KEY)/)).toBe(true);
    expect(via('alert_recipients', /lib\/alerting\.js _getSetting\(\)/)).toBe(true);
    expect(via('email_it', / cfg\(\)$/)).toBe(true);
    expect(via('firm_address', / cfgJson\(\)$/)).toBe(true);
    expect(via('landing_hosts', / cfgList\(\)$/)).toBe(true);
    expect(via('gcontacts_exclude_email_domains', /services\/gContactsService\.js SQL$/)).toBe(true);   // joined across +
    expect(via('internal_api_key_prev', /routes\/admin\.apiKeys\.js SQL$/)).toBe(true);
    expect(via('gcontacts_group', /SQL$/)).toBe(true);                                             // INSERT … VALUES ('k'
    expect(via('cta_default_timeout_once', /services\/ctaService\.js (getSetting\(\)|const SETTING_TIMEOUT)/)).toBe(true);
    expect(via('esign_webhook_last_seen_at', /lib\/internal_functions\/esign\.js getSetting\(\)/)).toBe(true);   // svc.X_KEY
    expect(via('comms_transcribe_mode', /services\/commsTranscribeSweep\.js getSettings\(\)$/)).toBe(true);   // Object.values(KEYS)
    expect(via('portal_logo_href', /routes\/portal\.branding\.js SQL params$/)).toBe(true);   // keys = Object.values(MAP)
    expect(via('fe-lead_sources', /routes\/api\.firmData\.js SQL LIKE 'fe-%'$/)).toBe(true);
    expect(via('dropbox_unsorted_generated_path', /services\/documentGenerateService\.js const UNSORTED_PATH_KEY$/)).toBe(true);
    expect(via('clio_login_code', /routes\/api\.jwt\.js SQL$/)).toBe(true);                 // \`key\` = "k" in a template
    expect(via('billing_tasks_to', /services\/courtExecutor\.js SQL$/)).toBe(true);          // \`key\`='k', no spaces
  });

  test('object maps count only when used: a *_KEYS map of non-settings is not a reader', () => {
    // services/mailbox/mailboxSendService.js BODY_KEYS, esignWebhookService
    // ID_HINT_KEYS, courtExecutor CH13_ONLY_EVENT_KEYS hold body fields, id
    // hints and event keys — never passed to a settings read.
    for (const k of ['body_text', 'notification_id', 'confirmation_hearing']) expect(FOUND.has(k)).toBe(false);
  });

  test('prose is not a key: comments are skipped', () => {
    // esignWebhookService.js names the retired esign_webhook_hmac_mode only
    // in comments; eventService.js / apptService.js name the retired
    // unified_singleton_enabled only in comments.
    expect(FOUND.has('esign_webhook_hmac_mode')).toBe(false);
    expect(FOUND.has('unified_singleton_enabled')).toBe(false);
  });

  test('a realistic number of keys and files', () => {
    expect(FOUND.size).toBeGreaterThanOrEqual(60);
    const files = new Set([...FOUND.values()].flatMap((s) => [...s].map((x) => x.split(' ')[0])));
    expect(files.size).toBeGreaterThanOrEqual(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) REVERSE
// ─────────────────────────────────────────────────────────────────────────────

const PUBLIC = [...walk(path.join(ROOT, 'public'))]
  .filter((f) => /\.(html|js)$/.test(f))
  .map((abs) => ({ file: rel(abs), src: fs.readFileSync(abs, 'utf8') }));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const quotedRe = (k) => new RegExp(`(['"\`])${escapeRe(k)}\\1`);

function evidenceFor(key) {
  const where = [];
  const q = quotedRe(key);
  for (const f of SERVER) {
    if (f.file === REGISTRY_FILE) continue;
    if (q.test(f.code)) where.push(f.file);
  }
  for (const f of PUBLIC) if (q.test(f.src)) where.push(f.file);
  if (key.startsWith('fe-')) {
    const bare = key.slice(3);
    const bareRe = new RegExp(`(['"\`])${escapeRe(bare)}\\1|settings\\??\\.${escapeRe(bare)}\\b`);
    for (const f of PUBLIC) if (bareRe.test(f.src)) where.push(`${f.file} (bare)`);
  }
  return where;
}

describe('(b) reverse — every live registered key is named by the code', () => {
  test('THE GUARD — no registered, non-retired key without a quoted literal outside EXEMPT', () => {
    const bad = LIVE_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(EXEMPT, k) && !evidenceFor(k).length);
    expect(bad).toEqual([]);
  });

  test('EXEMPT holds no stale entry (each is registered, live, and really unnamed)', () => {
    for (const k of Object.keys(EXEMPT)) {
      expect({ k, live: LIVE_KEYS.includes(k), evidence: evidenceFor(k) }).toEqual({ k, live: true, evidence: [] });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) firmConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('(c) lib/firmConfig.js REGISTRY agrees with the settings registry', () => {
  test('every firmConfig key is registered, with the same env fallback', () => {
    const rows = Object.entries(FIRM_CONFIG).map(([k, d]) => ({
      k, registered: registry.isRegistered(k), env: registry.isRegistered(k) ? (registry.get(k).env || null) : '—',
      want: d.env || null,
    }));
    expect(rows.filter((r) => !r.registered || r.env !== r.want)).toEqual([]);
  });

  test('every registry entry that names an env is a firmConfig key (env documents firmConfig\'s fallback)', () => {
    const stray = Object.entries(SETTINGS).filter(([k, e]) => e.env && !Object.prototype.hasOwnProperty.call(FIRM_CONFIG, k))
      .map(([k]) => k);
    expect(stray).toEqual([]);
  });
});
