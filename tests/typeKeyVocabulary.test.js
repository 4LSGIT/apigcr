// tests/typeKeyVocabulary.test.js
//
/**
 * Unified Events U3 — scripts/typeKeyVocabulary.js
 *
 * E1's read-time vocabulary, lifted verbatim out of services/caseEventService.js
 * when the `type_key` column became the runtime source of truth. It stayed in
 * the tree for exactly one reason: scripts/genTypeKeyBackfill.js regenerates
 * U2's committed migration blocks from it, and tests/genTypeKeyBackfill.test.js
 * byte-checks the result. That check is the proof the column was filled with the
 * keys E1 derived — the thing that made U3's swap a no-op on the data.
 *
 * TWO PROMISES, and the first is the load-bearing one:
 *
 *   1. NO SERVICE IMPORTS IT. A frozen 2026-08-30 word list consulted at read
 *      time beside a live column is two sources of truth wearing one name, and
 *      the failure mode is silent: rows would keep rendering, with keys that
 *      stopped matching what the write path stores. This is the guard against
 *      somebody "restoring" the import when a row renders unclassified.
 *
 *   2. IT DID NOT CHANGE IN THE MOVE. Sizes, the row overrides, the normalized
 *      key form, and the shadow-refusal throw. If any of these drift, the
 *      generated migration drifts with them and genTypeKeyBackfill.test.js goes
 *      red — this suite says WHICH thing moved.
 *
 * Run:  npx jest tests/typeKeyVocabulary.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const vocabulary = require('../scripts/typeKeyVocabulary');

const ROOT = path.join(__dirname, '..');

/**
 * Source with comments removed.
 *
 * Needed because the assertions below are about what the CODE does, and both
 * files legitimately DISCUSS the old names in prose — caseEventService's header
 * explains what moved, and it has to, or the next reader re-derives the reason
 * from scratch. A grep that cannot tell an import from a sentence would force
 * the comments out, which is the wrong trade.
 */
const code = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
    .replace(/^\s*\/\/.*$/gm, '');          // line comments

// ─────────────────────────────────────────────────────────────────────────────
// 1. Isolation — the point of the file
// ─────────────────────────────────────────────────────────────────────────────

/** Every .js under a directory, recursively (no node_modules in these trees). */
function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

describe('the frozen vocabulary is generator-only', () => {
  test('NO service, route, lib or startup file requires it', () => {
    // The whole runtime surface, not just services/: a route or a lib helper
    // reaching for the vocabulary would be the same bug one layer over.
    const dirs = ['services', 'routes', 'lib', 'startup'].map((d) => path.join(ROOT, d));
    const offenders = [];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const file of jsFiles(dir)) {
        const src = fs.readFileSync(file, 'utf8');
        if (/require\(\s*['"][^'"]*typeKeyVocabulary['"]\s*\)/.test(src)) {
          offenders.push(path.relative(ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('caseEventService derives from the COLUMN and carries no vocabulary at all', () => {
    const svc = require('../services/caseEventService');
    // The three E1 exports the generator used to reach through are gone. A
    // consumer that still binds them gets undefined and fails loudly rather
    // than silently reading a stale map.
    expect(svc._EVENT_TYPE_KEYS).toBeUndefined();
    expect(svc._APPT_TYPE_KEYS).toBeUndefined();
    expect(svc._EVENT_ROW_OVERRIDES).toBeUndefined();

    // And no private copy crept back in under another name. Comments stripped:
    // the header explains what moved and names the old maps to do it.
    const src = code('services/caseEventService.js');
    expect(src).not.toMatch(/typeKeyVocabulary/);
    expect(src).not.toMatch(/EVENT_ROW_OVERRIDES/);
    expect(src).not.toMatch(/EVENT_TYPE_KEYS/);
    expect(src).not.toMatch(/APPT_TYPE_KEYS/);
    // No inlined type strings either — a hand-rolled `if (type === 'Hearing')`
    // would be the vocabulary back, minus the shadow-refusal guard.
    expect(src).not.toMatch(/'Confirmation Hearing'/);
    expect(src).not.toMatch(/'Initial Strategy Session'/);
  });

  test('the only importer is the generator', () => {
    // The EMITTED SQL comments still cite the E1 names ("-- events.type_key by
    // event_type (caseEventService._EVENT_TYPE_KEYS)") and MUST NOT be reworded:
    // they are inside the byte-equality window against a migration that has
    // already run. So the assertion drops the out.push() lines and looks only at
    // what the generator actually executes.
    const gen = code('scripts/genTypeKeyBackfill.js')
      .split('\n').filter((l) => !/^\s*out\.push\(/.test(l)).join('\n');
    expect(gen).toMatch(/require\('\.\/typeKeyVocabulary'\)/);
    expect(gen).not.toMatch(/caseEventService/);
  });

  test('the header says what it is', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'typeKeyVocabulary.js'), 'utf8');
    expect(src).toMatch(/FROZEN/);
    expect(src).toMatch(/NEVER IMPORTED BY A SERVICE/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Content — unchanged by the move
// ─────────────────────────────────────────────────────────────────────────────

describe('the vocabulary survived the move intact', () => {
  test('sizes and shape', () => {
    // Exact counts, not >20: this file is frozen, so a size change IS the bug.
    expect(vocabulary.EVENT_TYPE_KEYS.size).toBe(25);
    expect(vocabulary.APPT_TYPE_KEYS.size).toBe(28);
    expect(vocabulary.EVENT_ROW_OVERRIDES.size).toBe(4);
    for (const m of [vocabulary.EVENT_TYPE_KEYS, vocabulary.APPT_TYPE_KEYS,
                     vocabulary.EVENT_ROW_OVERRIDES]) {
      expect(m).toBeInstanceOf(Map);
    }
  });

  test('keys are the NORMALIZED form — the general_ci contract the backfill rides', () => {
    for (const k of vocabulary.EVENT_TYPE_KEYS.keys()) expect(k).toBe(k.trim().toLowerCase());
    for (const k of vocabulary.APPT_TYPE_KEYS.keys()) expect(k).toBe(k.trim().toLowerCase());
    expect(vocabulary.APPT_TYPE_KEYS.has('pre-filing meeting')).toBe(true);
    expect(vocabulary.APPT_TYPE_KEYS.has('Pre-Filing Meeting')).toBe(false);
  });

  test('the four row overrides, with their E1 values', () => {
    expect([...vocabulary.EVENT_ROW_OVERRIDES.keys()].sort((a, b) => a - b)).toEqual([4, 6, 107, 134]);
    expect(vocabulary.EVENT_ROW_OVERRIDES.get(4)).toEqual(['test', 'other']);
    expect(vocabulary.EVENT_ROW_OVERRIDES.get(6)).toEqual(['test', 'other']);
    expect(vocabulary.EVENT_ROW_OVERRIDES.get(107)).toEqual(['filing_fee_deadline', 'deadline']);
    expect(vocabulary.EVENT_ROW_OVERRIDES.get(134)).toEqual(['trial', 'hearing']);
  });

  test('341 is ONE key across both sides — the cross-table join U7 depends on', () => {
    expect(vocabulary.EVENT_TYPE_KEYS.get('341')[0])
      .toBe(vocabulary.APPT_TYPE_KEYS.get('341 meeting')[0]);
  });

  test('_vocab still REFUSES to build a shadowing map', () => {
    // Two spellings normalizing together with different values would silently
    // lose one and change a whole type's backfill. Load-time throw, kept.
    expect(() => vocabulary._vocab('test', {
      'Thing': ['a', 'meeting'],
      'THING': ['b', 'hearing'],
    })).toThrow(/refusing to shadow/);
    // Agreeing duplicates are fine — the vocabulary lists spelling variants.
    expect(() => vocabulary._vocab('test', {
      'Thing': ['a', 'meeting'],
      'THING': ['a', 'meeting'],
    })).not.toThrow();
  });

  test('_vkey is trim + lowercase', () => {
    expect(vocabulary._vkey('  Docs Deadline  ')).toBe('docs deadline');
    expect(vocabulary._vkey(null)).toBe('');
    expect(vocabulary._vkey(undefined)).toBe('');
  });
});
