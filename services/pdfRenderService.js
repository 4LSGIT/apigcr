// services/pdfRenderService.js
//
/**
 * HTML → PDF RENDERING — chromium via puppeteer-core, and nothing else.
 * services/pdfRenderService.js
 *
 * Phase 2B. This is the machinery under template sends and previews: a
 * template's HTML body, already interpolated, comes in; a PDF buffer goes out
 * to esignSendService for stamping and dispatch. This file knows nothing about
 * templates, prefills, or signatures — it renders HTML.
 *
 * ── DEPLOYMENT MODEL ────────────────────────────────────────────────────────
 * The container installs chromium via apt (see Dockerfile); puppeteer-core is
 * the driver only and downloads NO browser of its own. The binary is resolved
 * lazily, at first render:
 *
 *   1. env PUPPETEER_EXECUTABLE_PATH
 *   2. /usr/bin/chromium                 (debian's apt chromium)
 *   3. common alternates (chromium-browser, google-chrome[-stable])
 *
 * Resolution failure throws ESIGN_RENDER_NO_BROWSER *at render time*, never at
 * boot — the app must run fine on a machine without chromium (local dev, CI);
 * only the render feature is unavailable there.
 *
 * ── LIFECYCLE ───────────────────────────────────────────────────────────────
 * One browser, launched on first render, killed after 60s idle (timer resets
 * per render), relaunched transparently if it has died or disconnected. Cloud
 * Run bills for what runs; a chromium process idling between the firm's
 * handful of daily sends is money and memory for nothing.
 *
 * Renders are SERIALIZED through a promise queue — one page at a time. This is
 * a 4-person firm on a 1GiB container, not a render farm; two concurrent
 * chromium pages under memory pressure is how containers get OOM-killed
 * mid-send.
 *
 * ── NETWORK IS BLOCKED ──────────────────────────────────────────────────────
 * Request interception aborts every request that is not data:/about:. Template
 * HTML must be SELF-CONTAINED (inline CSS, data-URI images). A template that
 * references an external image or font fails loudly (ESIGN_RENDER_EXTERNAL_REF
 * listing the urls) rather than rendering differently on the day some CDN is
 * slow — a legal document that changes appearance depending on network weather
 * is worse than one that fails.
 *
 * ── ERRORS ──────────────────────────────────────────────────────────────────
 *   ESIGN_RENDER_NO_BROWSER    no chromium binary found
 *   ESIGN_RENDER_EXTERNAL_REF  html referenced external resources (.urls)
 *   ESIGN_RENDER_FAILED        launch/navigation/print failure (underlying
 *                              message included)
 */

const fs = require('fs');

/**
 * puppeteer-core is ESM-ONLY (v22+). In production, Node ≥22.12 loads it fine
 * through require(esm) — but jest's module runtime cannot, so a plain
 * top-level require would sink every suite that touches this file.
 *
 *   - Unit tests jest.mock('puppeteer-core'): the sandbox require below
 *     returns the mock and the catch never runs.
 *   - The integration suite (real chromium, no mock): the sandbox require
 *     throws jest's ESM SyntaxError, and the catch escapes to Node's NATIVE
 *     require via createRequire — which does support require(esm).
 *   - Production: the first branch just works.
 *
 * Loaded lazily (first render), never at module load — matching the file's
 * contract that a machine without chromium still boots the app.
 */
let _puppeteer = null;
function _loadPuppeteer() {
  if (_puppeteer) return _puppeteer;
  try {
    _puppeteer = require('puppeteer-core');
  } catch (err) {
    const { createRequire } = require('module');
    _puppeteer = createRequire(__filename)('puppeteer-core');
  }
  return _puppeteer;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** ms of idle (no render) after which the browser is closed. */
const IDLE_CLOSE_MS = 60 * 1000;

/** setContent navigation timeout. */
const NAV_TIMEOUT_MS = 15 * 1000;

/**
 * Launch args. --no-sandbox is required: Cloud Run containers run as a single
 * user with no privilege boundary for chromium's sandbox to build on, and the
 * only HTML rendered here is the firm's own templates — not hostile pages.
 */
const LAUNCH_ARGS = Object.freeze([
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
]);

/** Candidate binaries, tried in order after the env var. */
const EXECUTABLE_CANDIDATES = Object.freeze([
  '/usr/bin/chromium',            // debian apt chromium (the Dockerfile's)
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
]);

const DEFAULT_MARGINS = Object.freeze({
  top: '0.75in', bottom: '0.75in', left: '0.75in', right: '0.75in',
});

// ─────────────────────────────────────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────────────────────────────────────

function _err(code, message, extra = null) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

let _browser = null;       // live Browser, or null
let _launching = null;     // in-flight launch promise, or null
let _idleTimer = null;     // idle-close timeout handle
let _queue = Promise.resolve();  // render serialization chain
let _resolvedPath;         // memoized executable path (undefined = not tried)

/** Test hook: reset all module state. */
function _resetForTest() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = null;
  _browser = null;
  _launching = null;
  _queue = Promise.resolve();
  _resolvedPath = undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// BROWSER LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the chromium binary. Memoized after the first successful resolution;
 * a MISS is not memoized, so installing chromium fixes the next render
 * without a restart.
 *
 * @throws ESIGN_RENDER_NO_BROWSER
 */
function resolveExecutablePath() {
  if (_resolvedPath) return _resolvedPath;

  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    ...EXECUTABLE_CANDIDATES,
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        _resolvedPath = p;
        return p;
      }
    } catch (_) { /* unreadable path — keep looking */ }
  }

  throw _err(
    'ESIGN_RENDER_NO_BROWSER',
    'No chromium binary was found on this machine, so HTML cannot be rendered ' +
    'to PDF. On the deployed container chromium is installed by the Dockerfile; ' +
    'locally, install chromium or set PUPPETEER_EXECUTABLE_PATH. ' +
    `Looked at: ${candidates.join(', ')}`
  );
}

/** Is the current browser handle alive? (v25 exposes .connected; older API had isConnected()). */
function _browserAlive(b) {
  if (!b) return false;
  if (typeof b.connected === 'boolean') return b.connected;
  if (typeof b.isConnected === 'function') return b.isConnected();
  return true;
}

/**
 * The live browser, launching (or relaunching after a crash) as needed.
 * Concurrent callers share one launch.
 */
async function _getBrowser() {
  if (_browserAlive(_browser)) return _browser;
  _browser = null;

  if (!_launching) {
    const executablePath = resolveExecutablePath();
    _launching = _loadPuppeteer()
      .launch({ executablePath, args: [...LAUNCH_ARGS] })
      .then((b) => {
        _browser = b;
        _launching = null;
        return b;
      })
      .catch((err) => {
        _launching = null;
        throw _err(
          'ESIGN_RENDER_FAILED',
          `Chromium could not be launched: ${err && err.message}`,
          { cause: err }
        );
      });
  }
  return _launching;
}

/** (Re)arm the idle-close timer. Called after every render. */
function _armIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    _idleTimer = null;
    const b = _browser;
    _browser = null;
    if (b) {
      b.close().catch((err) => {
        console.error(`[PDF RENDER] idle close failed: ${err && err.message}`);
      });
    }
  }, IDLE_CLOSE_MS);
  // Never hold the process open just to close a browser later.
  if (typeof _idleTimer.unref === 'function') _idleTimer.unref();
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The actual render, run with the queue's exclusivity already held.
 */
async function _renderNow(html, { format, margins }) {
  const browser = await _getBrowser();

  let page = null;
  try {
    page = await browser.newPage();

    // ── network lockdown ────────────────────────────────────────────────────
    // Abort everything that is not data:/about:. Aborted requests are
    // COLLECTED rather than thrown from inside the event handler (throws there
    // vanish into the event loop); the check after setContent turns them into
    // one typed error naming every offending url.
    const externalUrls = [];
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('about:')) {
        req.continue().catch(() => {});
      } else {
        if (externalUrls.length < 20) externalUrls.push(url);
        req.abort('blockedbyclient').catch(() => {});
      }
    });

    await page.setContent(String(html == null ? '' : html), {
      waitUntil: 'networkidle0',
      timeout: NAV_TIMEOUT_MS,
    });

    if (externalUrls.length) {
      throw _err(
        'ESIGN_RENDER_EXTERNAL_REF',
        'The template references external resources, which is not allowed — ' +
        'template HTML must be self-contained (inline the CSS; use data: URIs ' +
        `for images). Blocked: ${externalUrls.join(', ')}`,
        { urls: externalUrls }
      );
    }

    const pdf = await page.pdf({
      format,
      margin: margins,          // puppeteer's key is `margin`
      printBackground: true,
    });

    // puppeteer-core v22+ returns a Uint8Array, not a Buffer.
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } catch (err) {
    if (err && (err.code === 'ESIGN_RENDER_EXTERNAL_REF' ||
                err.code === 'ESIGN_RENDER_NO_BROWSER' ||
                err.code === 'ESIGN_RENDER_FAILED')) {
      throw err;
    }
    throw _err(
      'ESIGN_RENDER_FAILED',
      `The document could not be rendered to PDF: ${err && err.message}`,
      { cause: err }
    );
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Render self-contained HTML to a PDF buffer.
 *
 * Serialized: concurrent calls run one at a time, in call order. A failed
 * render fails ITS caller only; the queue continues.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {string} [opts.format='Letter']
 * @param {object} [opts.margins]   {top,bottom,left,right} CSS lengths
 * @returns {Promise<Buffer>}
 * @throws  ESIGN_RENDER_NO_BROWSER | ESIGN_RENDER_EXTERNAL_REF | ESIGN_RENDER_FAILED
 */
function renderHtmlToPdf(html, { format = 'Letter', margins = DEFAULT_MARGINS } = {}) {
  const run = () => _renderNow(html, { format, margins });

  // Chain regardless of the predecessor's outcome; its failure was delivered
  // to its own caller and must not poison the queue.
  const result = _queue.then(run, run);

  // The queue tail must never be a rejected promise (that would surface as an
  // unhandled rejection when nothing chains after it) — park a settled tail.
  _queue = result.then(() => {}, () => {});

  // Idle timer re-arms after the render settles, success or failure.
  result.then(_armIdleTimer, _armIdleTimer);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  renderHtmlToPdf,
  resolveExecutablePath,
  // constants — tests pin these
  LAUNCH_ARGS,
  IDLE_CLOSE_MS,
  NAV_TIMEOUT_MS,
  DEFAULT_MARGINS,
  // test hooks
  _resetForTest,
  _getBrowser,
};
