/**
 * scripts/mobile-survey/survey.js — the one-time per-width retry on a
 * detached puppeteer frame (2026-11-11).
 *
 * Twice in two days a width's walk died on "Attempted to use detached Frame"
 * (a pane iframe reloaded under the walk's Frame handle), never reproducible
 * on a lone re-run — the harness losing its handle, not the page overflowing.
 * The driver now walks such a width ONCE more from a fresh page, discarding
 * the dead attempt's rows and counts; a second death, or any other error,
 * still ends the run with exit 2.
 *
 * The script runs its main IIFE on load, so it is not required here: the
 * classifier is lifted from the source by name and run bare, and the driver's
 * retry shape is pinned on the source — the loop bound, the rollback of the
 * report rows and both counters, and the rethrow condition (any other error;
 * the last attempt). A real walk of one width is the behavioural proof and is
 * part of every landing bundle's survey.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts/mobile-survey/survey.js'), 'utf8');

function fnSrc(name) {
  const m = new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(SRC);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

describe('mobile survey — detached-frame retry', () => {
  const isDetachedFrameError = new Function(`${fnSrc('isDetachedFrameError')}; return isDetachedFrameError;`)(); // eslint-disable-line no-new-func

  test('classifies puppeteer\'s detached-frame error and nothing else', () => {
    expect(isDetachedFrameError(new Error("Attempted to use detached Frame '5467067F259C2670A2C3271D08F0A8BC'."))).toBe(true);
    expect(isDetachedFrameError("Attempted to use detached Frame 'X'")).toBe(true);
    expect(isDetachedFrameError(new Error('Waiting for selector `.tab` failed: 23000ms'))).toBe(false);
    expect(isDetachedFrameError(new Error('Execution context was destroyed'))).toBe(false);
    expect(isDetachedFrameError(null)).toBe(false);
    expect(isDetachedFrameError({})).toBe(false);
  });

  test('the driver walks a width at most twice, rolls the dead attempt back, and rethrows anything else or a second death', () => {
    expect(SRC).toContain('const WIDTH_ATTEMPTS = 2;');
    expect(SRC).toContain('for (const W of WIDTHS) for (let attempt = 1; attempt <= WIDTH_ATTEMPTS; attempt++) {');
    expect(SRC).toContain('const mark = { rows: report.length, overflowCount, errorCount };');
    // The happy path leaves the attempt loop after one walk.
    expect(SRC).toMatch(/await page\.close\(\);\n\s*break;\n\s*\} catch \(err\) \{/);
    // Any other error, or the last attempt, ends the run as before.
    expect(SRC).toContain('if (!isDetachedFrameError(err) || attempt >= WIDTH_ATTEMPTS) throw err;');
    // The dead attempt's rows and both counters are discarded before the re-walk.
    expect(SRC).toContain('report.length = mark.rows; overflowCount = mark.overflowCount; errorCount = mark.errorCount;');
    // The exit-code policy is unchanged: overflow (or errors with the flag) → 1, a thrown error → 2.
    expect(SRC).toContain('process.exit(overflowCount || (FAIL_ON_ERRORS && errorCount) ? 1 : 0);');
    expect(SRC).toContain("})().catch((e) => { console.error(e); process.exit(2); });");
  });
});
