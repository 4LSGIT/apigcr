/**
 * tests/documentsUi.related.test.js
 *
 * BOOTS public/documents.html for real, in jsdom, with the REAL
 * public/js/yc-sync.js evaluated first — so the bus under test is the shipped
 * bus. (tests/caseUi.sync.test.js is the harness this is built on.)
 *
 * WHY THIS FILE EXISTS
 *
 * S3.1 gives the scoped widget a UNION of targets instead of one, and three of
 * the resulting behaviours are run-time-only — no amount of reading the file
 * proves them:
 *
 *   · THE BADGE IS THE HONESTY OF THE FEATURE. With "Include related" on, the
 *     list mixes this case's own documents with a related contact's. A row
 *     that is here because of somebody ELSE must say so, and a row that is
 *     this case's own must NOT (a badge on every row is noise, and noise is
 *     how a real badge stops being read). The direct/hop split is decided from
 *     the `via` array the server attaches, per row, at render time.
 *
 *   · THE BUS WATCHES THE UNION, NOT ONE ADDRESS. S3 subscribed to the exact
 *     `doclink:<type>:<id>`, which was complete when the view showed exactly
 *     one target's documents. It is not complete now: link a document to the
 *     RELATED contact and the case widget — the surface that should now show
 *     it — hears nothing on the old subscription. This is the regression test
 *     for that, driven over a real BroadcastChannel between two windows.
 *
 *   · AND IT MUST STILL IGNORE EVERYTHING ELSE. The subscription is a wildcard
 *     with a JS-side filter, so the original concern (a link action against an
 *     unrelated case costing this frame a refetch) has to be re-proved rather
 *     than assumed — it now depends on the filter rather than on the address.
 *
 * ON THE HARNESS SHAPE (load-bearing, read before editing)
 *
 * documents.html resolves its transport through `shellRealm()`, which demands a
 * window that is NOT this one — `window.top !== window` with an `apiSend` on
 * it. A top-level jsdom window fails that by definition (its own `top` is
 * itself), so this page cannot be booted the way tests/caseUi.sync.test.js
 * boots case.html: it must live in a REAL IFRAME, with the shell's surface on
 * the outer window. Getting that wrong does not fail loudly — the boot loop
 * just polls forever and every assertion sees an empty page.
 *
 * The iframe is `about:blank`, which has no query string, and jsdom will not
 * navigate one to a URL that has one (`about:blank?x` never finishes loading,
 * and `history.replaceState` refuses to cross the origin). So the page's script
 * is evaluated inside a function whose parameter SHADOWS `location`. That is
 * exact rather than approximate because the page touches `location` in exactly
 * one place — and there is a fence below asserting it still does, so this
 * harness cannot rot quietly into a lie.
 *
 * ON MODELLING BroadcastChannel ORDERING (also load-bearing)
 *
 * In production the sniff runs in the SHELL's realm and reaches this frame over
 * BroadcastChannel — a MACROTASK — so a writer's own continuation (and the
 * `linksLastRefresh` stamp in it) always runs FIRST. The stub apiSend defers
 * its sniff by one macrotask for exactly that reason.
 *
 *   npx jest tests/documentsUi.related.test.js
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

const CASE_ID = 'aB3xY9';

/** A documents row as the list endpoint returns one. */
function doc(id, over = {}) {
  return {
    id, source: 'dropbox', external_id: `id:${id}`,
    name: `file-${id}.pdf`, path: `/r/case a/file-${id}.pdf`,
    ext: 'pdf', size: 1024, status: 'active',
    server_modified: '2026-08-01T10:00:00Z',
    title: null, doc_type: null, tags: null, shared_link: null,
    ...over,
  };
}

const DIRECT_VIA  = [{ link_type: 'case', link_id: CASE_ID, label: '25-04172-prh', direct: true }];
const HOP_VIA     = [{ link_type: 'contact', link_id: '1001', label: 'Ross, Fred', relate_type: 'Primary' }];
const TARGETS     = [
  { link_type: 'case', link_id: CASE_ID, label: '25-04172-prh', direct: true },
  { link_type: 'contact', link_id: '1001', label: 'Ross, Fred', relate_type: 'Primary' },
];

/**
 * Boot documents.html in jsdom against a stub shell.
 *
 * @param {object}   o
 * @param {object[]} o.responses  successive GET /api/documents bodies. The boot
 *   consumes the first; a refetch consumes the next (the last one repeats),
 *   which is how a test observes that a refetch actually re-read the server.
 * @param {string}   o.query      the page's own query string (scope).
 */
async function boot({ responses = [], query = `?link_type=case&link_id=${CASE_ID}` } = {}) {
  // The SHELL (outer) and the widget (inner iframe) — see the header for why
  // this cannot be one window.
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
    : [{ documents: [], total: 0, limit: 25, offset: 0 }];

  const apiSend = async (url, method, params) => {
    calls.push({ url, method, params });
    let data = { status: 'success' };
    if (url === '/api/documents' && method === 'GET') {
      data = list[Math.min(ix++, list.length - 1)];
    }
    // The BroadcastChannel macrotask — see the header.
    window.setTimeout(() => {
      try { window.YC && window.YC._sniff(method, url, data); } catch (_) { /* noop */ }
    }, 0);
    return data;
  };

  // On the SHELL, which is what shellRealm() reaches through window.top.
  shell.apiSend = apiSend;

  const toasts = [];
  window.Swal = {
    mixin: () => ({ fire: (o) => { toasts.push(o); } }),
    fire: async () => ({ isConfirmed: false }),
    close: () => {},
  };

  // The bus lives in the WIDGET's realm — that is the frame under test.
  TEARDOWNS.push(bcPolyfill.install(window));
  window.eval(YCSYNC);

  // Markup first (the inline block touches the DOM at top level), comments
  // stripped so a `<script>` MENTIONED in a comment cannot split a block.
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  window.document.body.innerHTML =
    noComments.replace(/<script[\s\S]*?<\/script>/g, '');

  const inline = [...noComments.matchAll(
    /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  expect(inline.length).toBe(1);   // fence: a second block means this harness is stale

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));

  // jsdom has no layout and therefore no Element.prototype.scrollTo, which the
  // pager calls after a page change. A real browser has it; without this stub
  // gotoPage throws and the test measures jsdom rather than the page.
  window.Element.prototype.scrollTo = function () {};

  // `location` is SHADOWED, not stubbed globally — see the header. The page's
  // state is private to its IIFE, so every assertion below reads the DOM it
  // rendered rather than its internals, which is the honest surface anyway.
  window.eval(
    '(function (location) {\n' + inline[0] + '\n})(' +
    JSON.stringify({ search: query }) + ');',
  );

  await tick(window, 30);
  return { window, shell, calls, toasts, errors, dom };
}

// The shadow above is only exact while every `location` touch is one this
// harness models. There are two, and they are different KINDS:
//
//   READ   `new URLSearchParams(location.search)` — the shadow supplies
//          `search`, which is the whole reason it exists.
//   WRITE  `location.href = …` in onGenerateClick (G3). A write to a plain
//          object is a no-op, so the shadow absorbs it: nothing navigates,
//          nothing throws, and no test below is affected. Naming it here is
//          what keeps the count from being a number nobody can explain.
//
// A THIRD touch means this harness has stopped being exact — check what it
// does before bumping the number.
test('HARNESS FENCE: documents.html touches `location` exactly twice', () => {
  const hits = HTML.match(/\blocation\s*\./g) || [];
  expect(hits.length).toBe(2);
  expect(HTML).toContain('new URLSearchParams(location.search)');
  expect(HTML).toContain("location.href = '/documents/generateForm.html'");
});

/** Every rendered row's text, in order. */
const rowsOf = (w) => [...w.document.querySelectorAll('tr.doc-row')]
  .map(tr => tr.textContent.replace(/\s+/g, ' ').trim());
const badgesOf = (w) => [...w.document.querySelectorAll('.chip.via')]
  .map(el => el.textContent.replace(/\s+/g, ' ').trim());
const listCalls = (calls) => calls.filter(c => c.url === '/api/documents');

// ─────────────────────────────────────────────────────────────
// The toggle
// ─────────────────────────────────────────────────────────────

describe('Include related — the toggle', () => {
  test('is ON at boot and sends related=1 with the scope', async () => {
    // Default-off would ship the feature and hide it: staff would keep seeing
    // the short direct list they already had.
    const { window, calls } = await boot();

    expect(window.document.getElementById('tb-related').checked).toBe(true);
    const p = listCalls(calls)[0].params;
    expect(p).toMatchObject({ link_type: 'case', link_id: CASE_ID, related: 1 });
  });

  test('unchecking it OMITS the param rather than sending 0', async () => {
    // '0' is a TRUTHY string on the wire. Omission has no such trap.
    const { window, calls } = await boot();
    const cb = window.document.getElementById('tb-related');
    cb.checked = false;
    cb.dispatchEvent(new window.Event('change'));
    await tick(window, 30);

    const p = listCalls(calls)[1].params;
    expect(p).not.toHaveProperty('related');
    expect(p).toMatchObject({ link_type: 'case', link_id: CASE_ID });
  });

  test('toggling resets to page 1 — the result set just changed size', async () => {
    const many = { documents: [doc(1)], total: 500, limit: 25, offset: 0 };
    const { window, calls } = await boot({ responses: [many] });

    window.gotoPage(6);
    await tick(window, 30);
    expect(listCalls(calls).pop().params.offset).toBe(125);

    const cb = window.document.getElementById('tb-related');
    cb.checked = false;
    cb.dispatchEvent(new window.Event('change'));
    await tick(window, 30);
    expect(listCalls(calls).pop().params.offset).toBe(0);
  });

  test('the GLOBAL page has no toggle and never sends related', async () => {
    const { window, calls } = await boot({ query: '' });
    expect(window.document.body.classList.contains('scoped')).toBe(false);
    expect(listCalls(calls)[0].params).not.toHaveProperty('related');
  });
});

// ─────────────────────────────────────────────────────────────
// The badge
// ─────────────────────────────────────────────────────────────

describe('via badges — whose document is this', () => {
  const mixed = {
    documents: [doc(1, { via: DIRECT_VIA }), doc(2, { via: HOP_VIA })],
    total: 2, limit: 25, offset: 0,
    related: true, related_targets: TARGETS,
  };

  test('a DIRECT row is clean and a HOP row is badged with the record it came through', async () => {
    const { window } = await boot({ responses: [mixed] });

    expect(rowsOf(window).length).toBe(2);
    const badges = badgesOf(window);
    expect(badges).toEqual(['via contact: Ross, Fred (Primary)']);

    // And the badge is on the RIGHT row — not merely present on the page.
    const rows = [...window.document.querySelectorAll('tr.doc-row')];
    expect(rows[0].querySelector('.chip.via')).toBeNull();
    expect(rows[1].querySelector('.chip.via')).not.toBeNull();
  });

  test('a row matched BOTH ways is treated as the case\'s own — no badge', async () => {
    // It IS this case's document. Badging it as borrowed would be a lie, and
    // the server puts the direct entry first precisely so this is decidable.
    const { window } = await boot({
      responses: [{
        documents: [doc(1, { via: DIRECT_VIA.concat(HOP_VIA) })],
        total: 1, limit: 25, offset: 0, related: true, related_targets: TARGETS,
      }],
    });
    expect(badgesOf(window)).toEqual([]);
  });

  test('the badge does not depend on the server\'s ordering of via', async () => {
    // Belt to the direct-first sort's braces: if that order ever changes, a
    // direct row must still come out clean.
    const { window } = await boot({
      responses: [{
        documents: [doc(1, { via: HOP_VIA.concat(DIRECT_VIA) })],
        total: 1, limit: 25, offset: 0, related: true, related_targets: TARGETS,
      }],
    });
    expect(badgesOf(window)).toEqual([]);
  });

  test('a relate type is shown when present and omitted when not', async () => {
    const { window } = await boot({
      responses: [{
        documents: [doc(2, { via: [{ link_type: 'contact', link_id: '1001', label: 'Ross, Fred' }] })],
        total: 1, limit: 25, offset: 0, related: true, related_targets: TARGETS,
      }],
    });
    expect(badgesOf(window)).toEqual(['via contact: Ross, Fred']);
  });

  test('NO badges when the server sent no via at all (related off)', async () => {
    const { window } = await boot({
      responses: [{ documents: [doc(1), doc(2)], total: 2, limit: 25, offset: 0 }],
    });
    expect(rowsOf(window).length).toBe(2);
    expect(badgesOf(window)).toEqual([]);
  });

  test('a label carrying HTML is ESCAPED — contact names are user data', async () => {
    const { window } = await boot({
      responses: [{
        documents: [doc(2, { via: [{ link_type: 'contact', link_id: '1', label: '<img src=x onerror=alert(1)>' }] })],
        total: 1, limit: 25, offset: 0, related: true, related_targets: TARGETS,
      }],
    });
    expect(window.document.querySelector('.chip.via img')).toBeNull();
    expect(badgesOf(window)[0]).toContain('<img src=x onerror=alert(1)>');
  });
});

// ─────────────────────────────────────────────────────────────
// The "also showing" note
// ─────────────────────────────────────────────────────────────

describe('the related note', () => {
  test('names the related records so the toggle is legible even on an all-direct page', async () => {
    const { window } = await boot({
      responses: [{
        documents: [doc(1, { via: DIRECT_VIA })],
        total: 1, limit: 25, offset: 0, related: true, related_targets: TARGETS,
      }],
    });
    const note = window.document.getElementById('relNote').textContent;
    expect(note).toContain('Ross, Fred');
    expect(note).toContain('Primary');
    // The scope itself is not "also" — it is the thing being looked at.
    expect(note).not.toContain('25-04172-prh');
  });

  test('says nothing when the scope has no related records', async () => {
    const { window } = await boot({
      responses: [{
        documents: [], total: 0, limit: 25, offset: 0,
        related: true, related_targets: [TARGETS[0]],
      }],
    });
    expect(window.document.getElementById('relNote').textContent.trim()).toBe('');
  });

  test('warns when the target set was CAPPED — a short list must not look complete', async () => {
    const { window } = await boot({
      responses: [{
        documents: [], total: 0, limit: 25, offset: 0,
        related: true, related_targets: TARGETS, related_truncated: true,
      }],
    });
    const el = window.document.querySelector('.rel-note.warn');
    expect(el).not.toBeNull();
    expect(el.textContent).toMatch(/not shown/i);
  });

  test('is CLEARED when the toggle goes off — no stale "also showing" line', async () => {
    const { window } = await boot({
      responses: [
        { documents: [], total: 0, limit: 25, offset: 0, related: true, related_targets: TARGETS },
        { documents: [], total: 0, limit: 25, offset: 0 },
      ],
    });
    expect(window.document.getElementById('relNote').textContent).toContain('Ross, Fred');

    const cb = window.document.getElementById('tb-related');
    cb.checked = false;
    cb.dispatchEvent(new window.Event('change'));
    await tick(window, 30);

    expect(window.document.getElementById('relNote').textContent.trim()).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────
// The bus — the union, not one address
// ─────────────────────────────────────────────────────────────

describe('doclink bus — the watched set is the whole target set', () => {
  /** A second window that only exists to emit onto the shared channel. */
  function otherFrame() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'https://app.4lsg.com/other.html', runScripts: 'dangerously',
    });
    DOMS.push(dom);
    TEARDOWNS.push(bcPolyfill.install(dom.window));
    dom.window.eval(YCSYNC);
    return dom.window;
  }

  const related = {
    documents: [doc(1, { via: DIRECT_VIA })],
    total: 1, limit: 25, offset: 0, related: true, related_targets: TARGETS,
  };

  test('a change to the RELATED contact refetches — the S3 subscription missed this', async () => {
    // THE regression. Link a document to the client and the case's widget is
    // exactly the surface that should now show it.
    const { window, calls } = await boot({ responses: [related] });
    const before = listCalls(calls).length;

    otherFrame().YC.emit('doclink:contact:1001', { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    expect(listCalls(calls).length).toBe(before + 1);
  });

  test('a change to the SCOPED target still refetches', async () => {
    const { window, calls } = await boot({ responses: [related] });
    const before = listCalls(calls).length;

    otherFrame().YC.emit(`doclink:case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    expect(listCalls(calls).length).toBe(before + 1);
  });

  test('a change to an UNRELATED case is IGNORED — the wildcard is filtered, not open', async () => {
    // The subscription widened to `doclink:*`, so the original "do not refetch
    // on every link action anywhere" property now rests on the filter and has
    // to be re-proved rather than inherited.
    const { window, calls } = await boot({ responses: [related] });
    const before = listCalls(calls).length;

    otherFrame().YC.emit('doclink:case:SOMEONEELSE', { yc_refetch: 1 }, 'test');
    otherFrame().YC.emit('doclink:contact:99999', { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    expect(listCalls(calls).length).toBe(before);
  });

  test('with the toggle OFF, a related-contact change is ignored again', async () => {
    // The view no longer shows that contact's documents, so it has no reason
    // to care — and the watched set must contract, not just grow.
    const { window, calls } = await boot({
      responses: [related, { documents: [doc(1)], total: 1, limit: 25, offset: 0 }],
    });
    const cb = window.document.getElementById('tb-related');
    cb.checked = false;
    cb.dispatchEvent(new window.Event('change'));
    await tick(window, 30);

    const before = listCalls(calls).length;
    otherFrame().YC.emit('doclink:contact:1001', { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    expect(listCalls(calls).length).toBe(before);
  });

  test('the GLOBAL page ignores doclink entirely', async () => {
    const { window, calls } = await boot({ query: '' });
    const before = listCalls(calls).length;

    otherFrame().YC.emit('doclink:contact:1001', { yc_refetch: 1 }, 'test');
    otherFrame().YC.emit(`doclink:case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    expect(listCalls(calls).length).toBe(before);
  });

  test('a document:* VALUE message still repaints one row without a fetch', async () => {
    // S3 behaviour, re-proved because the row renderer changed underneath it.
    const { window, calls } = await boot({ responses: [related] });
    const before = listCalls(calls).length;

    otherFrame().YC.emit('document:1', { title: 'Renamed by another tab' }, 'test');
    await tick(window, 400);

    expect(listCalls(calls).length).toBe(before);
    expect(rowsOf(window)[0]).toContain('Renamed by another tab');
  });

  test('a repainted row KEEPS its badge — the value path must not strip via', async () => {
    const { window } = await boot({
      responses: [{
        documents: [doc(2, { via: HOP_VIA })],
        total: 1, limit: 25, offset: 0, related: true, related_targets: TARGETS,
      }],
    });
    expect(badgesOf(window)).toEqual(['via contact: Ross, Fred (Primary)']);

    otherFrame().YC.emit('document:2', { title: 'Retitled' }, 'test');
    await tick(window, 400);

    expect(rowsOf(window)[0]).toContain('Retitled');
    expect(badgesOf(window)).toEqual(['via contact: Ross, Fred (Primary)']);
  });
});

// ─────────────────────────────────────────────────────────────
// The ext facet (GLOBAL mode)
// ─────────────────────────────────────────────────────────────

describe('the File facet', () => {
  test('exists only in GLOBAL mode', async () => {
    const globalPage = await boot({ query: '' });
    expect(globalPage.window.document.getElementById('tb-ext')).not.toBeNull();
    expect(globalPage.window.document.getElementById('toolbar').style.display).toBe('');

    const scoped = await boot();
    expect(scoped.window.document.getElementById('toolbar').style.display).toBe('none');
  });

  test('a category sends its CSV of extensions', async () => {
    const { window, calls } = await boot({ query: '' });
    const sel = window.document.getElementById('tb-ext');
    sel.value = 'doc,docx,rtf,odt';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 30);

    expect(listCalls(calls).pop().params.ext).toBe('doc,docx,rtf,odt');
  });

  test('"Any" omits the param entirely rather than sending an empty string', async () => {
    // URLSearchParams stringifies a blank facet as '', which is not the same
    // request as not filtering.
    const { window, calls } = await boot({ query: '' });
    const sel = window.document.getElementById('tb-ext');
    sel.value = 'pdf';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 30);
    expect(listCalls(calls).pop().params.ext).toBe('pdf');

    sel.value = '';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 30);
    expect(listCalls(calls).pop()).not.toHaveProperty('params.ext');
  });

  test('every option value is inside the shape the API will accept', async () => {
    // The service drops tokens outside /^[a-z0-9]{1,20}$/ as junk, so an
    // option carrying one would be a category that silently filters on less
    // than it says.
    const { window } = await boot({ query: '' });
    const opts = [...window.document.querySelectorAll('#tb-ext option')]
      .map(o => o.value).filter(Boolean);
    expect(opts.length).toBeGreaterThan(4);
    for (const v of opts) {
      for (const tok of v.split(',')) expect(tok).toMatch(/^[a-z0-9]{1,20}$/);
    }
  });

  test('the empty state mentions filters once a facet is set', async () => {
    const { window } = await boot({ query: '' });
    const sel = window.document.getElementById('tb-ext');
    sel.value = 'pdf';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 30);
    expect(window.document.getElementById('listWrap').textContent)
      .toMatch(/match your filters/i);
  });
});

// ─────────────────────────────────────────────────────────────
// Boot health
// ─────────────────────────────────────────────────────────────

test('the page boots clean in both modes', async () => {
  const scoped = await boot({
    responses: [{
      documents: [doc(1, { via: DIRECT_VIA }), doc(2, { via: HOP_VIA })],
      total: 2, limit: 25, offset: 0, related: true, related_targets: TARGETS,
    }],
  });
  expect(scoped.errors).toEqual([]);

  const global = await boot({ query: '' });
  expect(global.errors).toEqual([]);
});
