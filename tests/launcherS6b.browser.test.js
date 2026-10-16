/**
 * INTEGRATION: ui-custom S6b in real Chrome — Home rows wrap only at the
 * screen edge or a break (the default layout keeps 3 / 3 / 3 / …; eight items
 * with no break go 8 across at 1300 and wrap inside a phone), the sidebar's
 * Home stays pinned while a sidebar taller than the window scrolls (wide,
 * skinny and the phone drawer; labels unsquashed, Open Files still toggles,
 * the edge only once scrolled), the icon-only #homeAll opens All, and a
 * placed `logout` shortcut opens the Log Out confirm. The scenarios are in
 * tests/helpers/homeLayoutBrowser.js (header lists them). The CSS hooks and
 * the launcher logic are tests/launcherS6b.test.js, on every run.
 *
 * ── GATED ON PUPPETEER_EXECUTABLE_PATH — SKIPPED OTHERWISE ──────────────────
 *   PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npx jest tests/launcherS6b.browser.test.js
 * Same opt-in and the same clean-subprocess reason as
 * tests/mailboxS2.renderBrowser.test.js. On a shared machine, run it through
 * the browser slot of local/heavy-gate.sh.
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const exe = process.env.PUPPETEER_EXECUTABLE_PATH;
const maybe = exe ? describe : describe.skip;

maybe('S6b — Home rows, the pinned sidebar Home, the All icon (real Chrome, subprocess)', () => {
  test('rows, sticky Home, All', () => {
    const script = path.join(__dirname, 'helpers', 'homeLayoutBrowser.js');
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [script], { env: process.env, encoding: 'utf8', timeout: 150000 });
    } catch (err) {
      stdout = String(err.stdout || '');
      if (!stdout.trim()) throw new Error(`homeLayoutBrowser failed: ${err.stderr || err.message}`);
    }
    const verdict = JSON.parse(stdout.trim().split('\n').pop());
    if (verdict.error) throw new Error(verdict.error);
    const failed = Object.keys(verdict.checks).filter((k) => !verdict.checks[k]);
    expect(failed).toEqual([]);
    expect(Object.keys(verdict.checks).length).toBeGreaterThanOrEqual(30);
    expect(verdict.ok).toBe(true);
  }, 180000);
});
