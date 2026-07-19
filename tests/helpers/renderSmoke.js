// tests/helpers/renderSmoke.js
//
// Real-chromium render smoke, run as a CLEAN NODE SUBPROCESS by
// tests/pdfRenderIntegration.test.js — NOT a jest test itself.
//
// Why a subprocess: puppeteer-core v22+ is ESM-only. Production Node (≥22.12)
// loads it through require(esm); jest's in-process CJS loader patching cannot,
// and it intercepts even module.createRequire, so there is no in-jest escape.
// A child `node` process has exactly the module semantics Cloud Run has —
// which makes this MORE faithful than an in-jest render, not a workaround.
//
// Contract: exercises services/pdfRenderService.js for real and prints ONE
// JSON line: { ok, checks: {...}, error? }. Exit 0 iff every check passed.
//
// Requires PUPPETEER_EXECUTABLE_PATH (or an installed /usr/bin/chromium).

const svc = require('../../services/pdfRenderService');
const { PDFDocument } = require('pdf-lib');

(async () => {
  const checks = {};
  try {
    // 1) a styled, self-contained document renders to a real PDF
    const pdf = await svc.renderHtmlToPdf(`
      <html><head><style>
        body { font-family: serif; margin: 0; }
        .box { border: 1px solid #000; padding: 8px; background: #eee; }
      </style></head><body>
        <h1>Retainer Agreement</h1>
        <p class="box">Between Legal Solutions Group and John Smith.</p>
      </body></html>`);
    checks.isBuffer  = Buffer.isBuffer(pdf);
    checks.hasMagic  = pdf.slice(0, 5).toString('latin1') === '%PDF-';
    checks.hasBytes  = pdf.length > 1000;

    // 2) the output survives the 2A stamping path — pdf-lib can load it
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    checks.stampable = doc.getPages().length >= 1;

    // 3) an external reference fails typed, not silently
    try {
      await svc.renderHtmlToPdf('<img src="https://example.com/logo.png">');
      checks.externalRefBlocked = false;
    } catch (err) {
      checks.externalRefBlocked = err.code === 'ESIGN_RENDER_EXTERNAL_REF';
    }

    const ok = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ ok, checks }));
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, checks, error: `${err.code || ''} ${err.message}` }));
    process.exit(1);
  } finally {
    svc._resetForTest();   // don't hold the process open on the idle browser
  }
})();
