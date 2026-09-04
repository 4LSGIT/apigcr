/**
 * tests/caseUi.detTab.test.js
 *
 * BOOTS public/case.html for real, in jsdom, and reads what the Detailed
 * Questionnaire tab's iframe actually points at (D3).
 *
 * WHY THIS FILE EXISTS
 *
 * `cases.case_detailed_form` is the one fact column for "which questionnaire
 * submission does this case have", and D3 gave it a second shape:
 *
 *   "yf:<submission_id>"  → the YisraForm staff view (render.html
 *                           ?view_submission, the same URL formInbox.html and
 *                           forms/submissionsWidget.html use)
 *   "<digits>"            → a legacy JotForm id; nothing internal renders those,
 *                           so the tab keeps showing case_detailed_link's PDF
 *   "" / null             → a request is outstanding; fall back the same way
 *
 * The prefix test is one line of a function nobody calls directly, wired into
 * applyCaseType, which only runs on a Bankruptcy case after a full entity load.
 * Reading the file proves the branch exists; only a boot proves it is REACHED
 * and that the fallback stayed byte-identical for the 126 legacy cases.
 *
 * THE FALLBACK ORDER IS THE POINT. sendingform-bk blanks case_detailed_form on
 * every send but deliberately leaves case_detailed_link alone, so a case can
 * legitimately hold BOTH a fresh yf: id and a stale JotForm PDF link. The yf:
 * branch must win, or staff read last year's answers. That case is tested.
 *
 * ON LEXICAL SCOPE (load-bearing — copied from tests/caseUi.sync.test.js)
 *
 * scripts.js and case.html's inline blocks are separate <script> tags in the
 * browser, where top-level `const`/`let` share ONE global lexical environment.
 * Per spec each eval gets its own declarative environment, so they must be
 * concatenated into a SINGLE eval to match browser semantics.
 *
 *   npx jest tests/caseUi.detTab.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/case.html'), 'utf8');
const YCSYNC  = fs.readFileSync(path.join(ROOT, 'public/js/yc-sync.js'), 'utf8');
const SCRIPTS = fs.readFileSync(path.join(ROOT, 'public/scripts.js'), 'utf8');

const DOMS = [];
const TEARDOWNS = [];
afterEach(() => {
  TEARDOWNS.splice(0).forEach(fn => fn());
  bcPolyfill.reset();
  DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) { /* noop */ } });
});

const tick = (w, ms) => new Promise(r => w.setTimeout(r, ms));

const CASE_ID = 'AAAAAAAA';

/** A Bankruptcy case — the only branch of applyCaseType that owns #det. */
function casePayload(over = {}) {
  return {
    case: {
      case_id: CASE_ID,
      case_stage: 'Open',
      case_status: 'New',
      case_rec: 'N/A',
      case_source: 'Referral',
      case_notes: '',
      case_alerts: '',
      case_caption: '',
      case_type: 'Bankruptcy',
      case_subtype: 'Ch. 7',
      case_number: '',
      case_number_full: '',
      case_detailed_form: null,
      case_detailed_link: null,
      ...over,
    },
    clients: [],
    appts: [],
    log: [],
  };
}

/**
 * Boot case.html in jsdom against a stub shell and return the #det src.
 * Modelled on tests/caseUi.sync.test.js's harness, trimmed to what a tab-src
 * assertion needs (no form pushes, no pipeline freshness, no visibility fence).
 */
async function bootDetSrc(caseOver) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: `https://app.4lsg.com/case.html?caseID=${CASE_ID}`,
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;

  // jsdom boots at visibilityState 'prerender' (document.hidden === true); a
  // real foreground tab is 'visible'.
  Object.defineProperty(window.document, 'hidden', {
    configurable: true, get: () => false,
  });

  const payload = casePayload(caseOver);
  const apiSend = async (url, method, params) => {
    if (url === `/api/cases/${CASE_ID}/pipeline`) {
      return { template: null, stages: [], history: [], current: null };
    }
    if (/^\/api\/cases\/[^/]+$/.test(url) && method === 'GET') {
      return params && params.include === 'appts' ? { appts: [] } : payload;
    }
    if (url === '/api/log')    return { entries: [], total: 0 };
    if (url === '/api/events') return { data: [] };
    return { status: 'success' };
  };

  // jsdom's window.parent IS the window for a top-level window, so putting the
  // shell's surface on `window` makes every `P.x` lookup resolve as it does in
  // the real iframe (scripts.js does `const P = window.parent`).
  window.apiSend  = apiSend;
  window.firmData = {
    users: [], phoneLines: [], emailFrom: [],
    settings: { case_types: { Bankruptcy: ['Ch. 7', 'Ch. 13'] },
                lead_sources: ['Referral'] },
    currentUser: { user: 6 }, firmTimezone: 'America/Detroit',
  };
  window.limit   = 100;
  window.addFile = () => {};

  // scripts.js builds window.Toast from Swal.mixin at evaluation time.
  window.Swal = {
    mixin: () => ({ fire: () => {} }),
    fire: async () => ({ isConfirmed: false }),
    close: () => {}, showLoading: () => {}, update: () => {},
    showValidationMessage: () => {}, resetValidationMessage: () => {},
    getConfirmButton: () => null, isLoading: () => false,
    stopTimer: () => {}, resumeTimer: () => {},
  };

  TEARDOWNS.push(bcPolyfill.install(window));
  window.eval(YCSYNC);

  // Markup first (the inline blocks touch the DOM at top level), comments
  // stripped so a `<script>` MENTIONED in a comment can't split a block.
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  window.document.body.innerHTML =
    noComments.replace(/<script[\s\S]*?<\/script>/g, '');

  const inline = [...noComments.matchAll(
    /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // Same fence tests/caseUi.sync.test.js keeps: an eighth block means one of
  // these harnesses is stale. D3 added no block (detTabSrc lives beside
  // applyCaseType, in the block that already owns the iframe srcs).
  expect(inline.length).toBe(7);

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));

  window.eval([SCRIPTS, ...inline].join('\n;\n'));

  await tick(window, 60);

  return {
    // getAttribute, not .src — jsdom resolves the property against the document
    // URL, and what this test is about is the string case.html assigned.
    src: window.document.getElementById('det').getAttribute('src'),
    errors,
    window,
  };
}

describe('Detailed Questionnaire tab src', () => {

  test('yf: prefix → the shared staff submission view', async () => {
    const { src, errors } = await bootDetSrc({ case_detailed_form: 'yf:4821' });
    expect(errors).toEqual([]);
    expect(src).toBe('/forms/render.html?view_submission=4821');
  });

  test('yf: wins over a stale case_detailed_link', async () => {
    // The re-request flow blanks case_detailed_form but deliberately NOT
    // case_detailed_link, so both columns populated is a real, expected state.
    const { src } = await bootDetSrc({
      case_detailed_form: 'yf:4821',
      case_detailed_link: 'https://www.dropbox.com/scl/fi/old.pdf?raw=1',
    });
    expect(src).toBe('/forms/render.html?view_submission=4821');
  });

  test('bare numeric (legacy JotForm) → the archived PDF, unchanged', async () => {
    const { src, errors } = await bootDetSrc({
      case_detailed_form: '6339362100717999458',
      case_detailed_link: 'https://www.dropbox.com/scl/fi/legacy.pdf?raw=1',
    });
    expect(errors).toEqual([]);
    expect(src).toBe('https://www.dropbox.com/scl/fi/legacy.pdf?raw=1');
  });

  test('outstanding request (blank column) → the last PDF, unchanged', async () => {
    const { src } = await bootDetSrc({
      case_detailed_form: '',
      case_detailed_link: 'https://www.dropbox.com/scl/fi/legacy.pdf?raw=1',
    });
    expect(src).toBe('https://www.dropbox.com/scl/fi/legacy.pdf?raw=1');
  });

  test('nothing at all → about:blank, unchanged', async () => {
    const { src, errors } = await bootDetSrc({});
    expect(errors).toEqual([]);
    expect(src).toBe('about:blank');
  });

  test('a bare "yf:" with no id degrades to the fallback, never a broken view', async () => {
    const { src } = await bootDetSrc({
      case_detailed_form: 'yf:',
      case_detailed_link: 'https://www.dropbox.com/scl/fi/legacy.pdf?raw=1',
    });
    expect(src).toBe('https://www.dropbox.com/scl/fi/legacy.pdf?raw=1');
  });

  test('the submission id is encoded, not interpolated raw', async () => {
    const { src } = await bootDetSrc({ case_detailed_form: 'yf:4&x=1' });
    expect(src).toBe('/forms/render.html?view_submission=4%26x%3D1');
  });

});
