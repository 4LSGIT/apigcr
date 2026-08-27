/**
 * tests/documentsUi.syncPanel.test.js
 *
 * BOOTS public/documents.html for real, in jsdom, and drives the S3.2 ops
 * surface: the Unlinked triage scope and the Sync panel.
 *
 * (tests/documentsUi.related.test.js is the harness this is built on — NOT
 * tests/caseUi.sync.test.js. See the iframe note below for why that
 * distinction is load-bearing rather than stylistic.)
 *
 * WHY THIS FILE EXISTS
 *
 * Every behaviour here is a run-time one, and three of them are the difference
 * between a panel that informs and a panel that misleads:
 *
 *   · THE CONTEXT LINE IS THE FEATURE. ~130,000 of ~153,000 documents have no
 *     case link and MOST ARE CORRECTLY SO — the firm's Dropbox spans practice
 *     areas and decades the `cases` table never covered. A six-figure number
 *     with no framing reads as a catastrophe and gets escalated. The line has
 *     to arrive WITH the number, which means it has to render on the same
 *     paint as the list.
 *
 *   · A WARNING IS NOT AN ERROR. Adding a root for a folder that does not
 *     exist yet SUCCEEDS — the root is created and starts working when the
 *     folder appears, which is the state three of the seeded roots are in
 *     today. If that renders red, someone goes hunting for a problem that is a
 *     scheduled outcome.
 *
 *   · A DIAGNOSTIC THAT PRODUCED NOTHING MUST SAY WHICH KIND OF NOTHING.
 *     Never run, failed, and kill-switch-skipped all produce an empty report,
 *     and only one of them means "nothing to report". Production had the last
 *     eight runs of documents_refresh_case_cache failing while every success
 *     behind them was a skip — a panel showing only the newest row would have
 *     rendered a clean, empty, entirely false all-clear.
 *
 *   · AND THE PANEL MUST COST NOTHING UNTIL ASKED FOR. It is lazy; a page open
 *     must not pay three requests so that one person can occasionally look.
 *
 * ON THE HARNESS SHAPE (load-bearing, read before editing)
 *
 * documents.html resolves its transport through `shellRealm()`, which demands
 * a window that is NOT this one — `window.top !== window` with an `apiSend` on
 * it. A top-level jsdom window fails that by definition, so the page must live
 * in a REAL IFRAME with the shell's surface on the outer window. Getting it
 * wrong does not fail loudly: the boot loop polls forever and every assertion
 * sees an empty page.
 *
 * The iframe is `about:blank`, which has no query string, so the page's script
 * is evaluated inside a function whose parameter SHADOWS `location`. The
 * related suite owns the fence asserting the page still touches `location`
 * exactly once, which is what keeps that shadow exact.
 *
 *   npx jest tests/documentsUi.syncPanel.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT   = path.join(__dirname, '..');
const HTML   = fs.readFileSync(path.join(ROOT, 'public/documents.html'), 'utf8');
const YCSYNC = fs.readFileSync(path.join(ROOT, 'public/js/yc-sync.js'), 'utf8');

const DOMS = [];
const TEARDOWNS = [];
afterEach(() => {
  TEARDOWNS.splice(0).forEach(fn => fn());
  bcPolyfill.reset();
  DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) { /* noop */ } });
});

const tick = (w, ms) => new Promise(r => w.setTimeout(r, ms));

/** The firm's real root shape — leading spaces and all. */
const ACTIVE_PATH = '/  Law Office/   Cases/  Active Cases';

function syncRoot(over = {}) {
  return {
    id: 1, path: ACTIVE_PATH, note: 'template tree — active',
    enabled: true, backfill_done: true, syncing_since: null,
    last_sync_at: '2026-08-27T07:10:03Z', last_error: null,
    stats: { mode: 'incremental', files: 0, pages: 1, linked: 0, ms: 538 },
    has_cursor: true,
    ...over,
  };
}

/**
 * Boot documents.html against a stub shell.
 *
 * @param {object} o
 * @param {object[]} o.responses   successive GET /api/documents bodies
 * @param {object}   o.routes      url → handler(method, params) for everything else
 * @param {string}   o.query       the page's own query string (scope)
 * @param {object}   o.swal        overrides for the Swal stub
 */
async function boot({ responses = [], routes = {}, query = '', swal = {} } = {}) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><iframe></iframe></body></html>',
    { url: 'https://app.4lsg.com/index.html', runScripts: 'dangerously' },
  );
  DOMS.push(dom);
  const shell  = dom.window;
  const window = shell.document.querySelector('iframe').contentWindow;

  const calls = [];
  let ix = 0;
  const list = responses.length
    ? responses
    : [{ documents: [], total: 0, limit: 30, offset: 0 }];

  const apiSend = async (url, method, params) => {
    calls.push({ url, method, params });

    if (url === '/api/documents' && method === 'GET') {
      return list[Math.min(ix++, list.length - 1)];
    }
    const key = method + ' ' + url;
    if (routes[key]) {
      const out = routes[key];
      return typeof out === 'function' ? out(params) : out;
    }
    if (routes[url]) {
      const out = routes[url];
      return typeof out === 'function' ? out(method, params) : out;
    }
    return { status: 'success' };
  };

  shell.apiSend = apiSend;

  const toasts = [];
  window.Swal = {
    mixin: () => ({ fire: (o) => { toasts.push(o); } }),
    fire: async (o) => { toasts.push(o); return { isConfirmed: !!swal.confirm }; },
    close: () => {},
    ...(swal.overrides || {}),
  };

  TEARDOWNS.push(bcPolyfill.install(window));
  window.eval(YCSYNC);

  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  window.document.body.innerHTML =
    noComments.replace(/<script[\s\S]*?<\/script>/g, '');

  const inline = [...noComments.matchAll(
    /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  expect(inline.length).toBe(1);   // fence: a second block means this harness is stale

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  window.Element.prototype.scrollTo = function () {};

  window.eval(
    '(function (location) {\n' + inline[0] + '\n})(' +
    JSON.stringify({ search: query }) + ');',
  );

  await tick(window, 30);
  return { window, shell, calls, toasts, errors, dom };
}

const listCalls  = (calls) => calls.filter(c => c.url === '/api/documents');
const rootCalls  = (calls) => calls.filter(c => c.url === '/api/documents/sync-roots');
const panelText  = (w) => w.document.getElementById('syncPanel').textContent
  .replace(/\s+/g, ' ').trim();

/* Paths are asserted through THIS, never through panelText: that helper
   collapses runs of whitespace, which is precisely the data these folder names
   carry ("  Active Cases" is a sort key, not formatting). Collapsing it in the
   assertion would let a page that mangled the spaces pass. */
const rootPaths = (w) => [...w.document.querySelectorAll('#syncPanel .root-path')]
  .map(el => el.textContent);

/** Open the panel and let its two fetches settle. */
async function openPanel(window) {
  window.document.getElementById('syncToggle')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick(window, 40);
}

function clickIn(window, selector) {
  const el = window.document.querySelector(selector);
  if (!el) throw new Error('no element for ' + selector);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return el;
}

const ROOTS_OK = (roots, enabled = true) => ({
  status: 'success', roots, sync_enabled: enabled,
});

// ═════════════════════════════════════════════════════════════════════════════
// The Unlinked triage scope
// ═════════════════════════════════════════════════════════════════════════════

describe('the Unlinked scope', () => {
  test('exists in GLOBAL mode and defaults to All', async () => {
    const { window, calls } = await boot();
    const sel = window.document.getElementById('tb-scope');
    expect(sel).not.toBeNull();
    expect(sel.value).toBe('');
    expect(listCalls(calls)[0].params).not.toHaveProperty('unlinked');
  });

  test('selecting Unlinked sends unlinked=case and resets to page 1', async () => {
    const many = { documents: [], total: 130338, limit: 30, offset: 0 };
    const { window, calls } = await boot({ responses: [many] });

    window.gotoPage(4);
    await tick(window, 30);
    expect(listCalls(calls).pop().params.offset).toBe(90);

    const sel = window.document.getElementById('tb-scope');
    sel.value = 'case';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 30);

    const p = listCalls(calls).pop().params;
    expect(p.unlinked).toBe('case');
    expect(p.offset).toBe(0);
  });

  test('THE CONTEXT LINE RENDERS WITH THE NUMBER, NOT AFTER SOMEONE ASKS', async () => {
    // 130k unlinked documents is not a defect count — most of the estate
    // predates the case list entirely. Without this line the view reads as a
    // catastrophic sync failure to the first person who opens it.
    const { window } = await boot({
      responses: [{
        documents: [], total: 0, limit: 30, offset: 0,
      }, {
        documents: [{ id: 1, name: 'a.pdf', ext: 'pdf', status: 'active', size: 1 }],
        total: 130338, limit: 30, offset: 0, unlinked: 'case',
      }],
    });

    const sel = window.document.getElementById('tb-scope');
    sel.value = 'case';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 30);

    const note = window.document.getElementById('scopeNote').textContent;
    expect(note).toMatch(/Most of these are correct/i);
    expect(note).toMatch(/triage surface, not an error count/i);
  });

  test('the line is CLEARED when the scope goes back to All', async () => {
    const { window } = await boot({
      responses: [{ documents: [], total: 5, limit: 30, offset: 0, unlinked: 'case' }],
    });
    const sel = window.document.getElementById('tb-scope');
    sel.value = 'case';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 30);
    expect(window.document.getElementById('scopeNote').textContent).toMatch(/Most of these/);

    sel.value = '';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 30);
    expect(window.document.getElementById('scopeNote').textContent.trim()).toBe('');
  });

  test('an EMPTY unlinked list is good news, and says so', async () => {
    // The generic "no documents in the registry" line would read as a failure
    // in exactly the situation that means everything is filed.
    const { window } = await boot({
      responses: [{ documents: [], total: 0, limit: 30, offset: 0, unlinked: 'case' }],
    });
    const sel = window.document.getElementById('tb-scope');
    sel.value = 'case';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 30);

    expect(window.document.getElementById('listWrap').textContent)
      .toMatch(/Every document has a case link/i);
  });

  test('the SCOPED widget has no scope control and never sends the param', async () => {
    // A scoped widget lists documents linked to something; "unlinked" there is
    // a guaranteed empty list.
    const { window, calls } = await boot({ query: '?link_type=case&link_id=aB3xY9' });
    expect(window.document.getElementById('toolbar').style.display).toBe('none');
    expect(listCalls(calls)[0].params).not.toHaveProperty('unlinked');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The Sync panel
// ═════════════════════════════════════════════════════════════════════════════

describe('the Sync panel — lazy by construction', () => {
  test('NOTHING is fetched at boot', async () => {
    // Every staffer opening the documents page would otherwise pay two extra
    // requests so that one person can occasionally look at the roots table.
    const { calls } = await boot();
    expect(rootCalls(calls)).toHaveLength(0);
    expect(calls.filter(c => c.url === '/api/documents/sync-diagnostics')).toHaveLength(0);
  });

  test('opening it fetches roots AND diagnostics, once', async () => {
    const { window, calls } = await boot({
      routes: { 'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]) },
    });

    await openPanel(window);
    expect(rootCalls(calls)).toHaveLength(1);
    expect(calls.filter(c => c.url === '/api/documents/sync-diagnostics'
                          && c.method === 'GET')).toHaveLength(1);

    // Closing and re-opening does not re-fetch — the data is already here.
    await openPanel(window);
    await openPanel(window);
    expect(rootCalls(calls)).toHaveLength(1);
  });

  test('the SCOPED widget has no Sync button at all', async () => {
    const { window } = await boot({ query: '?link_type=case&link_id=aB3xY9' });
    // The button lives in the topbar, which body.scoped hides; and the panel
    // is display:none !important there regardless.
    expect(window.document.body.classList.contains('scoped')).toBe(true);
    expect(window.document.getElementById('syncPanel').textContent.trim()).toBe('');
  });
});

describe('the Sync panel — roots table', () => {
  test('THE PATH IS RENDERED VERBATIM — leading spaces are data', async () => {
    // These folders are named "  Active Cases" and the spaces are the firm's
    // sort keys. A proportional font collapses them visually, which is why the
    // cell is monospace with pre-wrap; the text itself must be untouched.
    const { window } = await boot({
      routes: { 'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]) },
    });
    await openPanel(window);

    const cell = window.document.querySelector('.root-path');
    expect(cell.textContent).toBe(ACTIVE_PATH);
  });

  test('each state is named in words a human can act on', async () => {
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([
          syncRoot({ id: 1, backfill_done: true }),
          syncRoot({ id: 2, path: '/b', backfill_done: false, stats: { mode: 'empty_root' } }),
          syncRoot({ id: 3, path: '/c', backfill_done: false, stats: { mode: 'backfill' } }),
          syncRoot({ id: 4, path: '/d', enabled: false }),
          syncRoot({ id: 5, path: '/e', syncing_since: '2026-08-27T07:20:00Z' }),
        ]),
      },
    });
    await openPanel(window);

    const pills = [...window.document.querySelectorAll('#syncPanel .pill')]
      .map(p => p.textContent);
    expect(pills).toEqual(['incremental', 'empty', 'backfilling', 'disabled', 'running']);
  });

  test('an EMPTY root is not styled as a failure — path/not_found is legitimate', async () => {
    // Three seeded roots are created lazily by the upload / e-sign / forms
    // ladders. Marking them red would park a permanent false alarm in the
    // panel and teach people to ignore its colours.
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([
          syncRoot({ backfill_done: false, stats: { mode: 'empty_root' } }),
        ]),
      },
    });
    await openPanel(window);

    const pill = window.document.querySelector('#syncPanel .pill');
    expect(pill.textContent).toBe('empty');
    expect(pill.className).not.toMatch(/bad/);
  });

  test('LAST_ERROR IS VISIBLE, not hidden behind a hover', async () => {
    // It is the only record of why a root stopped moving, and a title
    // attribute is invisible on touch and unsearchable everywhere.
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([
          syncRoot({ last_error: 'cursor reset: dropbox → 409: reset' }),
        ]),
      },
    });
    await openPanel(window);

    expect(panelText(window)).toContain('cursor reset');
    expect(window.document.querySelector('[data-root-err]')).not.toBeNull();
  });

  test('THERE IS NO DELETE BUTTON', async () => {
    // A deleted root strands ~100k rows nothing claims and nothing revisits.
    // Disable is the safe verb and the only one offered.
    const { window } = await boot({
      routes: { 'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]) },
    });
    await openPanel(window);

    expect(window.document.querySelector('[data-root-delete]')).toBeNull();
    expect(panelText(window)).not.toMatch(/\bDelete\b|\bRemove\b/);
    expect(panelText(window)).toContain('Disable');
  });

  test('the kill-switch banner leads, and names the setting', async () => {
    // With the engine off, every timestamp below it is history. An orderly
    // roots table above no banner is the most misleading thing this panel
    // could show.
    const { window } = await boot({
      routes: { 'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()], false) },
    });
    await openPanel(window);

    const banner = window.document.querySelector('#syncPanel .banner');
    expect(banner.textContent).toMatch(/Sync is disabled/i);
    expect(banner.textContent).toContain('documents_sync_enabled');
  });

  test('no banner when the engine is running', async () => {
    const { window } = await boot({
      routes: { 'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()], true) },
    });
    await openPanel(window);
    expect(panelText(window)).not.toMatch(/Sync is disabled/i);
  });

  test('a roots FAILURE offers a retry instead of an empty panel', async () => {
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': () => { throw new Error('boom'); },
      },
    });
    await openPanel(window);
    expect(panelText(window)).toMatch(/Could not load sync status: boom/);
    expect(panelText(window)).toContain('Retry');
  });

  test('a DIAGNOSTICS failure does not take the roots table down with it', async () => {
    // They are separate fetches on purpose: the roots table is the actionable
    // half and must survive a job_results read that fails.
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
        'GET /api/documents/sync-diagnostics': () => { throw new Error('nope'); },
      },
    });
    await openPanel(window);
    expect(window.document.querySelector('.root-path').textContent).toBe(ACTIVE_PATH);
  });
});

describe('adding a root', () => {
  const addRoutes = (post) => ({
    'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
    'POST /api/documents/sync-roots': post,
  });

  test('A NOT-YET-EXISTING FOLDER IS A WARNING, NOT AN ERROR', async () => {
    // The root was created and will start working on its own. Rendering that
    // red sends someone hunting for a scheduled outcome.
    const { window } = await boot({
      routes: addRoutes({
        status: 'success',
        root: syncRoot({ id: 8, path: '/  Law Office/  Later', backfill_done: false }),
        warning: 'folder does not exist yet — will sync when created',
      }),
    });
    await openPanel(window);

    window.document.getElementById('rootPath').value = '/  Law Office/  Later';
    clickIn(window, '#rootAdd');
    await tick(window, 40);

    const msg = window.document.querySelector('#rootAddMsg .banner');
    expect(msg.className).toContain('warn');
    expect(msg.className).not.toContain('err');
    expect(msg.textContent).toMatch(/does not exist yet/);

    // AND THE ROW LANDED. A warning that also lost the root would be worse
    // than an error.
    expect(rootPaths(window)).toContain('/  Law Office/  Later');
  });

  test('a clean create is confirmed and the row appears', async () => {
    const { window } = await boot({
      routes: addRoutes({ status: 'success', root: syncRoot({ id: 8, path: '/  New' }) }),
    });
    await openPanel(window);

    window.document.getElementById('rootPath').value = '/  New';
    clickIn(window, '#rootAdd');
    await tick(window, 40);

    expect(window.document.querySelector('#rootAddMsg .banner').className).toContain('ok');
    expect(rootPaths(window)).toContain('/  New');
  });

  test('a REJECTION shows the reason and KEEPS the typed path', async () => {
    // The panel repaints on failure, and losing the input would make the user
    // retype a 60-character path with significant leading spaces to read the
    // error they just caused.
    const { window } = await boot({
      routes: addRoutes(() => {
        const e = new Error('this path sits INSIDE root 1 ("' + ACTIVE_PATH + '")');
        throw e;
      }),
    });
    await openPanel(window);

    const typed = ACTIVE_PATH + '/  Smith, John - 12345';
    window.document.getElementById('rootPath').value = typed;
    clickIn(window, '#rootAdd');
    await tick(window, 40);

    const msg = window.document.querySelector('#rootAddMsg .banner');
    expect(msg.className).toContain('err');
    expect(msg.textContent).toMatch(/sits INSIDE root 1/);
    expect(window.document.getElementById('rootPath').value).toBe(typed);
  });

  test('an empty path never reaches the server', async () => {
    const { window, calls } = await boot({
      routes: addRoutes({ status: 'success', root: syncRoot() }),
    });
    await openPanel(window);
    clickIn(window, '#rootAdd');
    await tick(window, 30);

    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
    expect(panelText(window)).toMatch(/Enter a folder path/);
  });

  test('the hint tells people about the leading spaces', async () => {
    // The single most common way a pasted path is silently wrong.
    const { window } = await boot({
      routes: { 'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]) },
    });
    await openPanel(window);
    expect(panelText(window)).toMatch(/including any leading spaces/i);
  });
});

describe('sync now', () => {
  const base = (post) => ({
    'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
    'POST /api/documents/sync-roots/1/sync': post,
  });

  test('A CLAIMED ROOT IS REPORTED AS SKIPPED, NOT AS A FAILURE', async () => {
    // The recurring tick may be mid-walk on this very root. An error dialog
    // teaches people to press the button again, which is the one thing that
    // cannot help.
    const { window, toasts } = await boot({
      routes: base({
        status: 'success',
        result: { root_id: 1, skipped: true, reason: 'claimed_elsewhere' },
      }),
    });
    await openPanel(window);
    clickIn(window, '[data-root-sync]');
    await tick(window, 40);

    const last = toasts[toasts.length - 1];
    expect(last.icon).toBe('info');
    expect(last.title).toMatch(/claimed_elsewhere/);
    expect(toasts.some(t => t.icon === 'error')).toBe(false);
  });

  test('a successful tick reports what moved and refetches the list', async () => {
    const { window, toasts, calls } = await boot({
      routes: base({
        status: 'success',
        result: { root_id: 1, mode: 'incremental', files: 12, linked: 3 },
        root: syncRoot({ last_sync_at: '2026-08-27T08:00:00Z' }),
      }),
    });
    await openPanel(window);
    const before = listCalls(calls).length;

    clickIn(window, '[data-root-sync]');
    await tick(window, 40);

    expect(toasts[toasts.length - 1].title).toMatch(/12 files · 3 linked/);
    // A manual tick can register or link documents, so the list behind the
    // panel is now stale.
    expect(listCalls(calls).length).toBe(before + 1);
  });

  test('an empty root says so rather than reporting "0 files"', async () => {
    const { window, toasts } = await boot({
      routes: base({ status: 'success', result: { root_id: 1, mode: 'empty_root', files: 0 } }),
    });
    await openPanel(window);
    clickIn(window, '[data-root-sync]');
    await tick(window, 40);

    expect(toasts[toasts.length - 1].title).toMatch(/does not exist yet/i);
  });

  test('the button is disabled while the tick is in flight', async () => {
    let release;
    const { window } = await boot({
      routes: base(() => new Promise((r) => { release = r; })),
    });
    await openPanel(window);
    clickIn(window, '[data-root-sync]');
    await tick(window, 10);

    expect(window.document.querySelector('[data-root-sync]').disabled).toBe(true);
    release({ status: 'success', result: { files: 0 } });
    await tick(window, 40);
    expect(window.document.querySelector('[data-root-sync]').disabled).toBe(false);
  });
});

describe('enable / disable', () => {
  test('disabling needs no ceremony', async () => {
    const { window, calls } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([syncRoot({ enabled: true })]),
        'PATCH /api/documents/sync-roots/1': {
          status: 'success', root: syncRoot({ enabled: false }),
        },
      },
    });
    await openPanel(window);
    clickIn(window, '[data-root-toggle]');
    await tick(window, 40);

    const patch = calls.find(c => c.method === 'PATCH');
    expect(patch.params).toEqual({ enabled: false });
    expect(window.document.querySelector('#syncPanel .pill').textContent).toBe('disabled');
  });

  test('ENABLING AN UN-BACKFILLED ROOT WARNS FIRST — it starts a walk', async () => {
    const { window, toasts, calls } = await boot({
      swal: { confirm: false },
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([
          syncRoot({ enabled: false, backfill_done: false }),
        ]),
      },
    });
    await openPanel(window);
    clickIn(window, '[data-root-toggle]');
    await tick(window, 40);

    const dialog = toasts.find(t => t.title === 'Enable this root?');
    expect(dialog).toBeDefined();
    expect(dialog.html).toMatch(/backfill mode/);
    expect(dialog.html).toMatch(/automations switched off/);
    // Declined → nothing was sent.
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(0);
  });

  test('an already-backfilled root re-enables without a dialog', async () => {
    const { window, calls } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([
          syncRoot({ enabled: false, backfill_done: true }),
        ]),
        'PATCH /api/documents/sync-roots/1': {
          status: 'success', root: syncRoot({ enabled: true }),
        },
      },
    });
    await openPanel(window);
    clickIn(window, '[data-root-toggle]');
    await tick(window, 40);

    expect(calls.find(c => c.method === 'PATCH').params).toEqual({ enabled: true });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Diagnostics — the whole reason S3.2 exists
// ═════════════════════════════════════════════════════════════════════════════

const DIAG = (over = {}) => ({
  status: 'success',
  reports: [
    {
      function_name: 'documents_refresh_case_cache',
      consecutive_failures: 0, last_run: null, last_report: null,
      ...(over.cache || {}),
    },
    {
      function_name: 'documents_attribution_report',
      consecutive_failures: 0, last_run: null, last_report: null,
      ...(over.attr || {}),
    },
  ],
});

describe('diagnostics — out_of_root', () => {
  test('cases outside every root are surfaced with their ids', async () => {
    // Those cases have a Dropbox folder no sync will ever walk, so their
    // documents will never be registered by any amount of correct code.
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
        'GET /api/documents/sync-diagnostics': DIAG({
          cache: {
            last_report: {
              executed_at: '2026-08-26T20:00:00Z',
              report: { resolved: 300, failed: 2, out_of_root: ['aB3xY9', 'zQ7'] },
            },
          },
        }),
      },
    });
    await openPanel(window);

    const text = panelText(window);
    expect(text).toMatch(/2 cases have a Dropbox folder under no enabled root/);
    expect(text).toContain('aB3xY9');
    expect(text).toContain('zQ7');
  });

  test('an empty out_of_root says so positively', async () => {
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
        'GET /api/documents/sync-diagnostics': DIAG({
          cache: {
            last_report: {
              executed_at: '2026-08-26T20:00:00Z',
              report: { resolved: 300, failed: 0, out_of_root: [] },
            },
          },
        }),
      },
    });
    await openPanel(window);
    expect(panelText(window)).toMatch(/Every resolved case folder sits under a sync root/);
  });

  test('A FAILURE STREAK IS SHOWN, and does not hide the last real figures', async () => {
    // Production, 2026-08-27: the newest eight runs had all failed with a
    // dropped MySQL connection while every success behind them was a
    // kill-switch skip. Showing only the newest row renders an empty block —
    // which reads as "nothing to report", the one meaning it does not have.
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
        'GET /api/documents/sync-diagnostics': DIAG({
          cache: {
            consecutive_failures: 8,
            last_run: {
              status: 'failed',
              error_message: "Can't add new command when connection is in closed state",
            },
            last_report: {
              executed_at: '2026-08-26T20:00:00Z',
              report: { resolved: 300, failed: 0, out_of_root: ['aB3xY9'] },
            },
          },
        }),
      },
    });
    await openPanel(window);

    const text = panelText(window);
    expect(text).toMatch(/The last 8 runs of .*documents_refresh_case_cache.* failed/);
    expect(text).toMatch(/connection is in closed state/);
    expect(text).toMatch(/from the last run that completed/);
    expect(text).toContain('aB3xY9');   // the figures survived the streak
  });

  test('a KILL-SWITCH SKIP is reported as a skip, not as findings', async () => {
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()], false),
        'GET /api/documents/sync-diagnostics': DIAG({
          cache: {
            last_run: { status: 'success', skipped: true, skip_reason: 'documents_sync_enabled is not "1"' },
          },
        }),
      },
    });
    await openPanel(window);

    const text = panelText(window);
    expect(text).toMatch(/most recent run was skipped/i);
    expect(text).toMatch(/No completed run has produced figures yet/);
  });

  test('never run reads as never run', async () => {
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
        'GET /api/documents/sync-diagnostics': DIAG(),
      },
    });
    await openPanel(window);
    expect(panelText(window)).toMatch(/No case-folder refresh has run/);
  });
});

describe('diagnostics — zero attribution (the stale intake folder)', () => {
  const REPORT = {
    cached_folders: 986,
    zero_attribution_cases: 418,
    cases_with_residue: 2,
    verdict: 'empty_abandoned — single-folder model holds',
    sample: [
      { case_id: 'aB3xY9', path_lower: '/  law office/   cases/  potential cases/  smith',
        total: 12, deleted: 12, active_linked_elsewhere: 0, active_unlinked: 0 },
      { case_id: 'zQ7kLm', path_lower: '/  law office/   cases/  potential cases/  jones',
        total: 3, deleted: 1, active_linked_elsewhere: 2, active_unlinked: 0 },
    ],
  };

  const withReport = (report) => ({
    'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
    'GET /api/documents/sync-diagnostics': DIAG({
      attr: { last_report: { executed_at: '2026-08-27T06:00:00Z', report } },
    }),
  });

  test('the COUNT, the CASE LIST and the EXPLANATION all render', async () => {
    // This block is why S3.2 exists. out_of_root cannot see this condition by
    // construction — the intake folder IS watched, it is merely empty — so
    // nothing else in the system reports it.
    const { window } = await boot({ routes: withReport(REPORT) });
    await openPanel(window);

    const text = panelText(window);
    expect(text).toMatch(/418 cases with a resolved folder and no documents/);
    expect(text).toMatch(/still points at the intake folder/);
    expect(text).toMatch(/re-linking ships in a later update/);
    expect(text).toContain('aB3xY9');
    expect(rootPaths(window)).toContain('/  law office/   cases/  potential cases/  smith');
  });

  test('the residue split is shown per case — the categories mean different things', async () => {
    // `deleted` supports the single-folder ruling (files moved out);
    // `active_linked_elsewhere` is the signal that would re-open it.
    const { window } = await boot({ routes: withReport(REPORT) });
    await openPanel(window);

    const text = panelText(window);
    expect(text).toMatch(/12 deleted/);
    expect(text).toMatch(/2 on another case/);
  });

  test('the shorter sample does not read as a contradiction of the count', async () => {
    // Only cases carrying residue appear in the sample; the rest are empty
    // folders. Two rows under a headline of 418 needs that said.
    const { window } = await boot({ routes: withReport(REPORT) });
    await openPanel(window);
    expect(panelText(window))
      .toMatch(/Only cases with documents still under the cached path are listed/);
  });

  test('zero cases is stated as a clean result', async () => {
    const { window } = await boot({
      routes: withReport({ cached_folders: 986, zero_attribution_cases: 0, sample: [] }),
    });
    await openPanel(window);
    expect(panelText(window))
      .toMatch(/Every case with a resolved folder holds at least one document/);
  });

  test('the RUN button produces the first report when none has ever run', async () => {
    // documents_attribution_report is deliberately unscheduled, so without
    // this the block could only ever say "never run" — a dead panel in the one
    // slice whose job is making this condition visible.
    const { window, calls } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
        'GET /api/documents/sync-diagnostics': DIAG(),
        'POST /api/documents/sync-diagnostics': {
          status: 'success', report: REPORT, ran_at: '2026-08-27T09:00:00Z',
        },
      },
    });
    await openPanel(window);
    expect(panelText(window)).toMatch(/No attribution report has run/);

    clickIn(window, '#diagRun');
    await tick(window, 40);

    expect(calls.filter(c => c.url === '/api/documents/sync-diagnostics'
                          && c.method === 'POST')).toHaveLength(1);
    const text = panelText(window);
    expect(text).toMatch(/418 cases with a resolved folder and no documents/);
    expect(text).toMatch(/Last run just now/);
  });

  test('the run button says it is READ-ONLY, because a scan button reads as dangerous', async () => {
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
        'GET /api/documents/sync-diagnostics': DIAG(),
      },
    });
    await openPanel(window);
    expect(panelText(window)).toMatch(/Read-only/);
  });

  test('a run while the kill switch is off reports the skip', async () => {
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()], false),
        'GET /api/documents/sync-diagnostics': DIAG(),
        'POST /api/documents/sync-diagnostics': {
          status: 'success',
          report: { skipped: true, reason: 'documents_sync_enabled is not "1"' },
        },
      },
    });
    await openPanel(window);
    clickIn(window, '#diagRun');
    await tick(window, 40);

    expect(panelText(window)).toMatch(/Sync is disabled, so the report did not run/);
  });

  test('an INCOMPLETE scan is flagged — the counts are then a lower bound', async () => {
    const { window } = await boot({
      routes: withReport({
        cached_folders: 986, zero_attribution_cases: 418, timed_out: true,
        verdict: 'incomplete_scan', sample: [],
      }),
    });
    await openPanel(window);
    expect(panelText(window)).toMatch(/incomplete scan/i);
    expect(panelText(window)).toMatch(/Verdict: incomplete_scan/);
  });
});

// ─────────────────────────────────────────────────────────────
// Boot health
// ─────────────────────────────────────────────────────────────

test('the page boots clean in both modes, and the panel opens clean', async () => {
  const globalPage = await boot({
    routes: {
      'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
      'GET /api/documents/sync-diagnostics': DIAG(),
    },
  });
  await openPanel(globalPage.window);
  expect(globalPage.errors).toEqual([]);

  const scoped = await boot({ query: '?link_type=case&link_id=aB3xY9' });
  expect(scoped.errors).toEqual([]);
});

test('an unexpected response body does not white-screen the panel', async () => {
  // The defensive half: a body with no `roots` key must render an empty table,
  // not throw halfway through a paint and leave the panel blank with no
  // explanation.
  const { window, errors } = await boot({
    routes: { 'GET /api/documents/sync-roots': { status: 'success' } },
  });
  await openPanel(window);

  expect(errors).toEqual([]);
  expect(panelText(window)).toMatch(/No sync roots configured/);
});

// ═════════════════════════════════════════════════════════════════════════════
// The guided re-link block (S3.3)
//
// The queue is ~418 rows of which ~24 can be acted on, and the two things this
// block can get catastrophically wrong are both about that gap:
//
//   · PRESENTING 418 PENDING REPAIRS. There are not 418 repairs. 410 of those
//     cases were never filed and the client never sent a document. A screen
//     that showed them all as work would teach the person working it that the
//     queue is noise — and the queue is the only place the ~24 real ones
//     surface.
//
//   · A CONFIRM BUTTON NEXT TO SOMEBODY ELSE'S FOLDER. A candidate already
//     linked to another case must render INERT — not disabled, absent. The
//     server 409s it too, but a control that exists is a control that gets
//     clicked, and the click is the confidentiality incident.
// ═════════════════════════════════════════════════════════════════════════════

const QUEUE_EMPTY = { status: 'success', total: 0, dismissed: 0, shown: 0,
  actionable: 0, no_candidate: 0, cases: [] };

const cand = (over = {}) => ({
  path: '/  Law Office/   Cases/  Active Cases/  Active - Bankruptcy/ 13 - myers, sharon',
  files: 164, newest: '2026-05-01T00:00:00Z', confidence: 'docket',
  matched_on: '23-46646-lsg', already_linked_to: null, nested_case_ids: null,
  inside_case_id: null, ...over,
});

const qCase = (over = {}) => ({
  case_id: 'X5zg4hU4', case_number_full: '23-46646-lsg', pipeline_phase: 'case',
  current_path: '/  Law Office/   Cases/  Potential Cases/ myers, sharon - x5zg4hu4',
  client_names: ['Myers, Sharon'], dismissed_at: null,
  candidates: [cand()], candidates_truncated: false, actionable: true, ...over,
});

const queueBody = (cases, over = {}) => ({
  status: 'success',
  total: cases.length, dismissed: 0, shown: cases.length,
  actionable: cases.filter(c => c.actionable).length,
  no_candidate: cases.filter(c => !c.actionable).length,
  cases, ...over,
});

const relinkRoutes = (queue, extra = {}) => ({
  'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
  'GET /api/documents/sync-diagnostics': { status: 'success', reports: [] },
  '/api/documents/relink/queue': queue,
  ...extra,
});

async function openRelink(window, caseId = 'X5zg4hU4') {
  const head = window.document.querySelector(`[data-relink-expand="${caseId}"]`);
  head.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick(window, 30);
}

describe('the re-link block', () => {
  test('THE FRAMING LINE ARRIVES WITH THE NUMBER', async () => {
    const cases = [qCase(), qCase({ case_id: 'aaaaaaa1', actionable: false, candidates: [] })];
    const { window } = await boot({
      routes: relinkRoutes(queueBody(cases)),
    });
    await openPanel(window);
    const txt = panelText(window);
    // "1 of 2" — not "2 cases need re-linking".
    expect(txt).toMatch(/1 of 2 cases have a folder we can suggest/);
    expect(txt).toMatch(/client never sent a document/);
  });

  test('actionable rows render; no-candidate rows are behind a collapsed strip', async () => {
    const cases = [qCase(), qCase({ case_id: 'aaaaaaa1', actionable: false, candidates: [] })];
    const { window } = await boot({ routes: relinkRoutes(queueBody(cases)) });
    await openPanel(window);

    expect(window.document.querySelector('[data-relink-expand="X5zg4hU4"]')).toBeTruthy();
    expect(window.document.querySelector('[data-relink-expand="aaaaaaa1"]')).toBeFalsy();
    expect(panelText(window)).toMatch(/1 with no matching folder/);
  });

  test('DOCKET-FIRST: the strong lane sorts above a name match', async () => {
    const nameCase = qCase({
      case_id: 'bbbbbbb1', case_number_full: null,
      candidates: [cand({ confidence: 'name', matched_on: 'Smith, John' })],
    });
    const { window } = await boot({
      routes: relinkRoutes(queueBody([nameCase, qCase()])),
    });
    await openPanel(window);
    const ids = [...window.document.querySelectorAll('[data-relink-expand]')]
      .map(el => el.getAttribute('data-relink-expand'));
    expect(ids[0]).toBe('X5zg4hU4');
  });

  test('THE PATHS KEEP THEIR LEADING SPACES', async () => {
    const { window } = await boot({ routes: relinkRoutes(queueBody([qCase()])) });
    await openPanel(window);
    await openRelink(window);
    const shown = [...window.document.querySelectorAll('#syncPanel .rl-row .root-path')]
      .map(el => el.textContent);
    // Asserted through the raw text, never panelText — that helper collapses
    // whitespace, which is precisely the data these folder names carry.
    expect(shown.some(p => p.includes('/  Law Office/   Cases/  Active Cases'))).toBe(true);
    expect(shown.some(p => p.includes('/  Law Office/   Cases/  Potential Cases'))).toBe(true);
  });

  test('AN ALREADY-LINKED CANDIDATE HAS NO CONFIRM CONTROL IN THE DOM', async () => {
    const taken = qCase({
      actionable: false,
      candidates: [cand({ already_linked_to: ['owner9'] })],
    });
    const { window } = await boot({
      routes: relinkRoutes(queueBody([taken], { actionable: 0, no_candidate: 1 })),
    });
    await openPanel(window);
    window.document.querySelector('[data-relink-toggle-nocand]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick(window, 20);
    await openRelink(window);

    expect(panelText(window)).toMatch(/already linked to case owner9/);
    // Not disabled. Absent.
    expect(window.document.querySelector('[data-relink-cand]')).toBeFalsy();
  });

  test('confirming posts the chosen folder and drops the row', async () => {
    const posts = [];
    const { window, calls } = await boot({
      swal: { confirm: true },
      routes: relinkRoutes(queueBody([qCase()]), {
        'POST /api/documents/relink': (p) => {
          posts.push(p);
          return { status: 'success', result: { linked_docs: 164, warnings: [] } };
        },
      }),
    });
    await openPanel(window);
    await openRelink(window);
    clickIn(window, '[data-relink-cand]');
    await tick(window, 40);

    expect(posts).toHaveLength(1);
    expect(posts[0].case_id).toBe('X5zg4hU4');
    expect(posts[0].folder_path).toBe(cand().path);
    expect(window.document.querySelector('[data-relink-expand="X5zg4hU4"]')).toBeFalsy();
    // A confirm attributes documents, so the list behind the panel is stale.
    expect(listCalls(calls).length).toBeGreaterThan(1);
  });

  test('cancelling the dialog posts NOTHING', async () => {
    const posts = [];
    const { window } = await boot({
      swal: { confirm: false },
      routes: relinkRoutes(queueBody([qCase()]), {
        'POST /api/documents/relink': (p) => { posts.push(p); return { status: 'success' }; },
      }),
    });
    await openPanel(window);
    await openRelink(window);
    clickIn(window, '[data-relink-cand]');
    await tick(window, 40);
    expect(posts).toHaveLength(0);
  });

  test('THE CONFIRM DIALOG SHOWS BOTH PATHS AND THE COUNT', async () => {
    const { window, toasts } = await boot({
      swal: { confirm: true },
      routes: relinkRoutes(queueBody([qCase()]), {
        'POST /api/documents/relink': { status: 'success', result: { linked_docs: 164, warnings: [] } },
      }),
    });
    await openPanel(window);
    await openRelink(window);
    clickIn(window, '[data-relink-cand]');
    await tick(window, 40);

    const dlg = toasts.find(t => t.title === 'Re-link this case?');
    expect(dlg).toBeTruthy();
    expect(dlg.html).toContain('/  Law Office/   Cases/  Potential Cases/ myers, sharon');
    expect(dlg.html).toContain('13 - myers, sharon');
    expect(dlg.html).toMatch(/164 documents/);
    expect(dlg.html).toMatch(/rewrites the case/);
  });

  test('a WEAK match needs a second tick, and an unticked box posts nothing', async () => {
    const weakCase = qCase({
      case_number_full: null,
      candidates: [cand({ confidence: 'weak', matched_on: 'mitchell' })],
    });
    const posts = [];
    const { window, toasts } = await boot({
      // isConfirmed true, but the checkbox value is absent → treated as unticked.
      swal: { confirm: true },
      routes: relinkRoutes(queueBody([weakCase]), {
        'POST /api/documents/relink': (p) => { posts.push(p); return { status: 'success' }; },
      }),
    });
    await openPanel(window);
    await openRelink(window);
    clickIn(window, '[data-relink-cand]');
    await tick(window, 40);

    expect(posts).toHaveLength(0);
    const dlg = toasts.find(t => t.title === 'Re-link this case?');
    expect(dlg.input).toBe('checkbox');
    expect(dlg.html).toMatch(/surname only/);
  });

  test('a SKIPPED confirm never paints as a success', async () => {
    const { window, toasts } = await boot({
      swal: { confirm: true },
      routes: relinkRoutes(queueBody([qCase()]), {
        'POST /api/documents/relink':
          { status: 'success', result: { skipped: true, reason: 'documents_sync_enabled is not "1"' } },
      }),
    });
    await openPanel(window);
    await openRelink(window);
    clickIn(window, '[data-relink-cand]');
    await tick(window, 40);

    expect(toasts.some(t => t.icon === 'success')).toBe(false);
    expect(toasts.some(t => /Skipped/.test(String(t.title || '')))).toBe(true);
    // Nothing changed, so the row must still be there.
    expect(window.document.querySelector('[data-relink-expand="X5zg4hU4"]')).toBeTruthy();
  });

  test('a 409 from the guard is reported and the row stays', async () => {
    const { window, toasts } = await boot({
      swal: { confirm: true },
      routes: relinkRoutes(queueBody([qCase()]), {
        'POST /api/documents/relink': () => {
          throw new Error('that folder is already linked to case owner9');
        },
      }),
    });
    await openPanel(window);
    await openRelink(window);
    clickIn(window, '[data-relink-cand]');
    await tick(window, 40);

    expect(toasts.some(t => /already linked to case owner9/.test(String(t.text || '')))).toBe(true);
    expect(window.document.querySelector('[data-relink-expand="X5zg4hU4"]')).toBeTruthy();
  });

  test('nesting disclosures reach the dialog', async () => {
    const cs = qCase({
      candidates: [cand({ inside_case_id: 'alicia1', nested_case_ids: ['sub1', 'sub2'] })],
    });
    const { window, toasts } = await boot({
      swal: { confirm: true },
      routes: relinkRoutes(queueBody([cs]), {
        'POST /api/documents/relink': { status: 'success', result: { linked_docs: 1, warnings: [] } },
      }),
    });
    await openPanel(window);
    await openRelink(window);
    clickIn(window, '[data-relink-cand]');
    await tick(window, 40);

    const dlg = toasts.find(t => t.title === 'Re-link this case?');
    expect(dlg.html).toMatch(/sits <b>inside case alicia1/);
    expect(dlg.html).toMatch(/2 other case folders sit inside this one/);
  });

  test('BULK DISMISS says plainly that it changes nothing', async () => {
    const cases = [qCase({ case_id: 'aaaaaaa1', actionable: false, candidates: [] }),
                   qCase({ case_id: 'aaaaaaa2', actionable: false, candidates: [] })];
    const posts = [];
    const { window, toasts } = await boot({
      swal: { confirm: true },
      routes: relinkRoutes(queueBody(cases), {
        'POST /api/documents/relink/dismiss': (p) => {
          posts.push(p);
          return { status: 'success', updated: p.case_ids.length };
        },
      }),
    });
    await openPanel(window);
    clickIn(window, '[data-relink-dismiss-all]');
    await tick(window, 40);

    const dlg = toasts.find(t => /Dismiss 2 cases/.test(String(t.title || '')));
    expect(dlg).toBeTruthy();
    expect(dlg.html).toMatch(/changes no document, no case and nothing in Dropbox/);
    expect(posts[0].case_ids).toEqual(['aaaaaaa1', 'aaaaaaa2']);
  });

  test('bulk dismiss NEVER includes an actionable case', async () => {
    const cases = [qCase(), qCase({ case_id: 'aaaaaaa1', actionable: false, candidates: [] })];
    const posts = [];
    const { window } = await boot({
      swal: { confirm: true },
      routes: relinkRoutes(queueBody(cases), {
        'POST /api/documents/relink/dismiss': (p) => { posts.push(p); return { status: 'success', updated: 1 }; },
      }),
    });
    await openPanel(window);
    clickIn(window, '[data-relink-dismiss-all]');
    await tick(window, 40);
    expect(posts[0].case_ids).toEqual(['aaaaaaa1']);
  });

  test('the weak toggle refetches THAT case with include_weak=1', async () => {
    const { window, calls } = await boot({
      routes: relinkRoutes(queueBody([qCase()]), {
        '/api/documents/relink/X5zg4hU4/candidates':
          { status: 'success', ...qCase(), candidates: [cand({ confidence: 'weak' })] },
      }),
    });
    await openPanel(window);
    await openRelink(window);
    clickIn(window, '[data-relink-weak="X5zg4hU4"]');
    await tick(window, 40);
    expect(calls.some(c =>
      c.url === '/api/documents/relink/X5zg4hU4/candidates?include_weak=1')).toBe(true);
  });

  test('a queue failure does NOT take the roots table down with it', async () => {
    const { window } = await boot({
      routes: {
        'GET /api/documents/sync-roots': ROOTS_OK([syncRoot()]),
        'GET /api/documents/sync-diagnostics': { status: 'success', reports: [] },
        '/api/documents/relink/queue': () => { throw new Error('ranking blew up'); },
      },
    });
    await openPanel(window);
    expect(rootPaths(window)).toContain(ACTIVE_PATH);
    expect(panelText(window)).toMatch(/Could not load the re-link queue/);
  });

  test('AND IT COSTS NOTHING UNTIL THE PANEL IS OPENED', async () => {
    const { window, calls } = await boot({ routes: relinkRoutes(QUEUE_EMPTY) });
    expect(calls.some(c => c.url.startsWith('/api/documents/relink'))).toBe(false);
    await openPanel(window);
    expect(calls.some(c => c.url.startsWith('/api/documents/relink'))).toBe(true);
  });

  test('the block is GLOBAL only — a scoped widget has no panel at all', async () => {
    const { window, calls } = await boot({
      query: '?link_type=case&link_id=X5zg4hU4',
      routes: relinkRoutes(queueBody([qCase()])),
    });
    await tick(window, 30);
    expect(calls.some(c => c.url.startsWith('/api/documents/relink'))).toBe(false);
  });
});
