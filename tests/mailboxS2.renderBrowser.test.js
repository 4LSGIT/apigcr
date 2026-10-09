/**
 * INTEGRATION: public/js/mailRender.js in real Chrome — each layer of the
 * hostile-mail renderer (sanitize / sandbox / CSP) stops a LIVE payload on
 * its own, against a control frame where the same payload demonstrably runs.
 * Mailbox-system arc, slice S2. The scenarios are in
 * tests/helpers/mailRenderBrowser.js (header lists them).
 *
 * ── GATED ON PUPPETEER_EXECUTABLE_PATH — SKIPPED OTHERWISE ──────────────────
 *   PUPPETEER_EXECUTABLE_PATH=/path/to/chrome npx jest tests/mailboxS2.renderBrowser.test.js
 * Same opt-in and the same clean-subprocess reason as
 * tests/pdfRenderIntegration.test.js. `npm test` without it: one skipped
 * suite; tests/mailboxS2.render.test.js covers the renderer's logic in jsdom
 * (including a mutant per layer) on every run.
 */

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const exe = process.env.PUPPETEER_EXECUTABLE_PATH;
const maybe = exe ? describe : describe.skip;

maybe('mailRender — layer isolation in real Chrome (subprocess)', () => {
  test('control runs; sanitize, sandbox and CSP each stop it alone; Show images loads images only', () => {
    const script = path.join(__dirname, 'helpers', 'mailRenderBrowser.js');
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [script], { env: process.env, encoding: 'utf8', timeout: 90000 });
    } catch (err) {
      throw new Error(`mailRenderBrowser failed: ${err.stdout || ''} ${err.stderr || ''}`);
    }
    const verdict = JSON.parse(stdout.trim().split('\n').pop());
    expect(verdict.checks).toEqual({
      controlScriptRuns: true,
      controlImageLoads: true,
      controlCssLoads: true,
      sanitizeAloneStopsScript: true,
      sanitizeAloneStopsRequests: true,
      sandboxAloneStopsScript: true,
      cspAloneStopsScript: true,
      cspAloneStopsRequests: true,
      fullStackStopsAll: true,
      showImagesLoadsImages: true,
      showImagesStillNoScript: true,
    });
    expect(verdict.ok).toBe(true);
  }, 120000);
});
