// tests/secretScan.test.js
//
/**
 * Pre-commit secret scan — access-control B4 (scripts/secret-scan.js,
 * .githooks/pre-commit; ref/ACCESS_CONTROL_DESIGN.md §5.5).
 *
 * WHAT IS LOCKED
 *   - Real key shapes are refused: yci_/yck_/ycro_ + a long hex body (today's
 *     mint), + a mixed-case base62 body (B3's), the ycro_ advisory suffix
 *     included; and every provider rule fires on a realistic sample.
 *   - FIXTURE DISCRIMINATION: every key-shaped WORD the test suite uses today
 *     passes (harvested from tests/ at run time, so a new fixture word that
 *     trips the scan fails HERE, not in someone's commit); the
 *     `secret-scan: allow` marker exempts one line.
 *   - Diff parsing: only ADDED lines, the right file and NEW-file line number
 *     across several hunks and files; removed lines, /dev/null targets and
 *     the generated / lock files are never scanned.
 *   - The hook runs the scan FIRST and refuses on its exit status.
 *
 * The end-to-end hook run (a planted key refused by a real `git commit`) is
 * documented in the B4 report — it needs a throwaway repository.
 *
 * Run: npx jest tests/secretScan.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RULES, ALLOW_MARKER, scanLine, scanDiff, redact, skipped } = require('../scripts/secret-scan');

const ROOT = path.join(__dirname, '..');
const hex = (n) => crypto.randomBytes(n / 2).toString('hex');
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const base62 = (n) => Array.from(crypto.randomBytes(n), b => B62[b % 62]).join('');
const rulesHit = (line) => scanLine(line).map(f => f.rule);

describe('real secrets are refused', () => {
  test('YisraCase keys in today\'s mint shape (prefix + 64 hex)', () => {
    for (const p of ['yci_', 'yck_', 'ycro_']) {
      expect(rulesHit(`const k = '${p}${hex(64)}';`)).toEqual(['YisraCase key (hex body)']);
    }
    expect(rulesHit(`X-Readonly-Api-Key: ycro_${hex(64)}_20261231T0000Z`)).toEqual(['YisraCase key (hex body)']);
    expect(rulesHit(`yck_${hex(32)}`)).toEqual(['YisraCase key (hex body)']);   // the floor
  });

  test('YisraCase keys in the B3 base62 shape', () => {
    let body;
    do { body = base62(22); } while (!(/[0-9]/.test(body) && /[A-Z]/.test(body) && /[a-z]/.test(body)));
    expect(rulesHit(`key=yck_${body}`)).toEqual(['YisraCase key (base62 body)']);
  });

  test('every provider rule fires on a realistic sample', () => {
    const samples = {
      'private key block': '-----BEGIN RSA PRIVATE KEY-----',   // secret-scan: allow (a header line, no key)
      'AWS access key id': 'AKIA' + 'Z7Q2X9W4M1P8K3J6',
      'Anthropic API key': 'sk-ant-api03-' + base62(40),
      'OpenAI API key': 'sk-proj-' + base62(40),
      'Google API key': 'AIza' + base62(35),
      'GitHub token': 'ghp_' + base62(36),
      'Slack token': 'xoxb-' + '1234567890-abcdefghij',
      'Slack webhook URL': 'https://hooks.slack.com/services/T0ABCDEF/B0ABCDEF/' + base62(24),
      'Stripe live key': 'sk_live_' + base62(24),
      'JWT': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + base62(43),
    };
    expect(Object.keys(samples).sort()).toEqual(RULES.map(r => r.name).filter(n => !n.startsWith('YisraCase')).sort());
    for (const [rule, s] of Object.entries(samples)) expect(rulesHit(`x = "${s}"`)).toContain(rule);
  });
});

describe('fixtures pass', () => {
  test('every key-shaped word the suite uses today passes (harvested from tests/)', () => {
    const words = new Set();
    for (const f of fs.readdirSync(path.join(ROOT, 'tests'))) {
      const p = path.join(ROOT, 'tests', f);
      if (!fs.statSync(p).isFile()) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/\b(?:yci|yck|ycro)_[A-Za-z0-9_]+/g)) words.add(m[0]);
    }
    expect(words.size).toBeGreaterThan(15);
    const tripped = [...words].filter(w => scanLine(`'${w}'`).length);
    expect(tripped).toEqual([]);
  });

  test('named fixture words, and near-misses', () => {
    for (const w of ['yck_not_a_real_key', 'yci_test_internal_key', 'ycro_legacy', 'ycro_scoped_20991231T0000Z',
                     'yci_SUPER_SECRET', `yck_${hex(30)}`, 'yck_alllowercaseletterslong', 'yck_ALLUPPERCASE1234567890']) {
      expect({ w, hits: scanLine(w) }).toEqual({ w, hits: [] });
    }
  });

  test(`the "${ALLOW_MARKER}" marker exempts its line only`, () => {
    const key = `yck_${hex(64)}`;
    expect(scanLine(`const k = '${key}'; // ${ALLOW_MARKER}`)).toEqual([]);
    expect(scanLine(`const k = '${key}';`)).toHaveLength(1);
  });

  test('a refusal never prints the whole secret', () => {
    const key = `yck_${hex(64)}`;
    const r = redact(key);
    expect(r.length).toBeLessThan(20);
    expect(key.includes(r.replace('…', ''))).toBe(false);
  });
});

describe('diff parsing', () => {
  const key = `yck_${hex(64)}`;
  const diff = [
    'diff --git a/lib/a.js b/lib/a.js',
    '--- a/lib/a.js',
    '+++ b/lib/a.js',
    '@@ -10,0 +11,2 @@',
    '+const ok = 1;',
    `+const k = '${key}';`,
    '@@ -40 +42 @@',
    `-const old = '${key}';`,
    `+const nu = 'clean';`,
    'diff --git a/tests/b.test.js b/tests/b.test.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/tests/b.test.js',
    '@@ -0,0 +1,3 @@',
    '+a',
    '+b',
    `+  token: 'ghp_${base62(36)}',`,
    'diff --git a/gone.js b/gone.js',
    '--- a/gone.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    `-const k = '${key}';`,
    'diff --git a/ref/database.sql b/ref/database.sql',
    '--- a/ref/database.sql',
    '+++ b/ref/database.sql',
    '@@ -1 +1 @@',
    `+-- ${key}`,
  ].join('\n');

  test('only added lines; the right file and new-file line numbers', () => {
    expect(scanDiff(diff).map(f => `${f.file}:${f.line} ${f.rule}`)).toEqual([
      'lib/a.js:12 YisraCase key (hex body)',
      'tests/b.test.js:3 GitHub token',
    ]);
  });

  test('generated and lock files are never scanned', () => {
    for (const f of ['ref/database.sql', 'ref/routes.md', 'TRACKED_FILES.txt', 'package-lock.json']) expect(skipped(f)).toBe(true);
    for (const f of ['lib/a.js', 'ref/migrations/x.sql', 'manual/README.md']) expect(skipped(f)).toBe(false);
  });

  test('an empty diff is clean', () => {
    expect(scanDiff('')).toEqual([]);
  });
});

describe('the hook', () => {
  const hookSrc = fs.readFileSync(path.join(ROOT, '.githooks', 'pre-commit'), 'utf8');
  // Order is judged on CODE lines — the header comment names the same commands.
  const hook = hookSrc.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

  test('runs the scan before every regen step and refuses on its status', () => {
    const scan = hook.indexOf('node scripts/secret-scan.js || exit 1');
    expect(scan).toBeGreaterThan(0);
    for (const later of ['node scripts/updateRoutes.js', 'node scripts/dump-schema.js', 'git ls-files > TRACKED_FILES.txt']) {
      expect(hook.indexOf(later)).toBeGreaterThan(scan);
    }
  });

  test('documents the SKIP_SECRET_SCAN escape hatch', () => {
    expect(hookSrc).toMatch(/SKIP_SECRET_SCAN=1 git commit/);
  });
});
