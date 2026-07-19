/**
 * INTEGRATION: a real chromium render through services/pdfRenderService.js.
 *
 * ── GATED ON PUPPETEER_EXECUTABLE_PATH — SKIPPED OTHERWISE ──────────────────
 * Launches a REAL browser; runs only when the env var points at a working
 * chromium/chrome binary:
 *
 *   PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npx jest tests/pdfRenderIntegration.test.js
 *
 * Explicit opt-in rather than auto-detection, deliberately: some machines
 * carry a /usr/bin/chromium-browser that is a snap STUB which resolves but
 * cannot launch (Ubuntu does this). `npm test` without the env var: one
 * skipped suite — correct, not a gap; tests/pdfRender.test.js covers the
 * service's logic with a mocked puppeteer.
 *
 * ── WHY A SUBPROCESS ────────────────────────────────────────────────────────
 * puppeteer-core v22+ is ESM-only. Production Node (≥22.12) loads it via
 * require(esm); jest's in-process CJS loader patching cannot — it feeds the
 * ESM source to the CJS compiler even through module.createRequire, so there
 * is no in-jest escape. The render therefore runs in a CLEAN CHILD NODE
 * PROCESS (tests/helpers/renderSmoke.js), which has exactly the module
 * semantics Cloud Run has. The child prints one JSON verdict line; the
 * assertions below read it.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const exe = process.env.PUPPETEER_EXECUTABLE_PATH;
const maybe = exe ? describe : describe.skip;

maybe('pdfRenderService — real chromium render (subprocess)', () => {
  test('renders, stamps, and blocks external refs against a real browser', () => {
    const script = path.join(__dirname, 'helpers', 'renderSmoke.js');

    let stdout;
    try {
      stdout = execFileSync(process.execPath, [script], {
        env: process.env,
        encoding: 'utf8',
        timeout: 60000,
      });
    } catch (err) {
      // Non-zero exit still carries the verdict line — surface it.
      throw new Error(`renderSmoke failed: ${err.stdout || ''} ${err.stderr || ''}`);
    }

    const lastLine = stdout.trim().split('\n').pop();
    const verdict = JSON.parse(lastLine);

    expect(verdict.checks).toEqual({
      isBuffer: true,
      hasMagic: true,
      hasBytes: true,
      stampable: true,
      externalRefBlocked: true,
    });
    expect(verdict.ok).toBe(true);
  }, 90000);
});
