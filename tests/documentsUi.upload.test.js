// tests/documentsUi.upload.test.js
//
/**
 * public/documents.html — THE STAFF UPLOAD FLOW (Documents S4), booted for real
 * in jsdom with the shipped public/js/yc-sync.js evaluated first.
 *
 * (tests/documentsUi.related.test.js is the harness this is built on; its
 * header explains why the page must live in a REAL IFRAME — shellRealm()
 * demands a window that is not this one — and why `location` is shadowed
 * rather than stubbed. Both of its fences are re-asserted at the bottom of this
 * file, because this slice edits the same page and either fence rotting would
 * make BOTH suites quietly measure nothing.)
 *
 * ── WHAT IS RUN-TIME-ONLY HERE ──────────────────────────────────────────────
 * The upload is three hops and only ONE of them is this app's server, so
 * reading the file proves nothing about whether they compose:
 *
 *   · THE ORDER AND THE HANDOFF. /upload-link's `ticket` must reach
 *     /upload-commit, and Dropbox's `id` — read out of the raw XHR response
 *     body, which the two client upload pages throw away — must reach it too.
 *     A regression that dropped either would still upload the file
 *     successfully and just silently stop registering it.
 *
 *   · A FAILED TRANSFER LEAVES NO ROW. The commit is what creates the
 *     document, so a Dropbox POST that 500s must not produce an optimistic row
 *     for a file that does not exist. This is the one failure mode that would
 *     put a lie on screen rather than an error.
 *
 *   · THE ECHO FENCE. /upload-commit announces `doclink:<scope>` and this very
 *     frame subscribes to it, so without the linksLastRefresh stamp every
 *     upload costs one pointless extra list GET — the exact waste the fence was
 *     introduced for on the link/unlink path.
 *
 *   · THE OPTIMISTIC INSERT IS CONDITIONAL. Prepending is only honest under
 *     the default sort (`modified` DESC, where a file uploaded four seconds ago
 *     genuinely IS the newest row). Under any other sort, a filter, or page 2,
 *     the correct position is a question only the list query can answer.
 *
 * ON THE XHR STUB: the page reaches Dropbox with XMLHttpRequest (copied from
 * public/docReq.html — POST, octet-stream, real upload.onprogress events), so
 * the stub replaces window.XMLHttpRequest in the WIDGET's realm. jsdom's own
 * XHR would attempt a real network call.
 *
 *   npx jest tests/documentsUi.upload.test.js
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

/**
 * Boot the page.
 *
 * @param {object}   o
 * @param {object[]} o.responses  successive GET /api/documents bodies
 * @param {string}   o.query      the page's scope
 * @param {object}   o.api        per-endpoint overrides, keyed 'METHOD url'
 * @param {object}   o.xhr        { status?, body?, fail? } for the Dropbox POST
 */
async function boot({
  responses = [], query = `?link_type=case&link_id=${CASE_ID}`, api = {}, xhr = {},
} = {}) {
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
    const key = `${method} ${url}`;
    let data;

    if (Object.prototype.hasOwnProperty.call(api, key)) {
      const v = api[key];
      data = typeof v === 'function' ? v(params, calls) : v;
      if (data instanceof Error) throw data;
    } else if (url === '/api/documents' && method === 'GET') {
      data = list[Math.min(ix++, list.length - 1)];
    } else if (url === '/api/documents/upload-link') {
      data = {
        status: 'success', ticket: `tkt-for-${params.filename}`,
        link: 'https://content.dropboxapi.com/apitul/1/xyz',
        path: `/cases/smith/${params.filename}`, placement: 'case',
      };
    } else if (url === '/api/documents/upload-commit') {
      data = {
        status: 'success', document: doc(900 + calls.length, { name: 'uploaded.pdf' }),
        link_type: 'case', link_id: CASE_ID, relation: 'path',
      };
    } else {
      data = { status: 'success' };
    }

    // The BroadcastChannel macrotask — a writer's own continuation (and the
    // linksLastRefresh stamp in it) always runs FIRST in production.
    window.setTimeout(() => {
      try { window.YC && window.YC._sniff(method, url, data); } catch (_) { /* noop */ }
    }, 0);
    return data;
  };
  shell.apiSend = apiSend;

  const toasts = [];
  window.Swal = {
    mixin: () => ({ fire: (o) => { toasts.push(o); } }),
    fire: async () => ({ isConfirmed: false }),
    close: () => {},
  };

  // The Dropbox transfer. Records what it was sent so the test can assert the
  // contract the two shipped client pages established (POST, octet-stream).
  const puts = [];
  window.XMLHttpRequest = function () {
    this.upload = {};
    this.open = (m, u) => { this._m = m; this._u = u; };
    this.setRequestHeader = (k, v) => { this._h = { ...(this._h || {}), [k]: v }; };
    this.send = (body) => {
      puts.push({ method: this._m, url: this._u, headers: this._h, body });
      window.setTimeout(() => {
        if (this.upload.onprogress) {
          this.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 });
        }
        if (xhr.fail) return this.onerror && this.onerror();
        this.status = xhr.status || 200;
        this.responseText = xhr.body !== undefined
          ? xhr.body
          : JSON.stringify({ id: 'id:LANDED', name: 'uploaded.pdf', path_display: '/cases/smith/uploaded.pdf' });
        this.onload && this.onload();
      }, 0);
    };
  };

  TEARDOWNS.push(bcPolyfill.install(window));
  window.eval(YCSYNC);

  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  window.document.body.innerHTML = noComments.replace(/<script[\s\S]*?<\/script>/g, '');

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
  return { window, shell, calls, puts, toasts, errors };
}

/** Put files on the hidden input and run the handler the change event runs. */
async function upload(window, names) {
  const inp = window.document.getElementById('upInput');
  const files = names.map(n => {
    const f = new window.File(['x'.repeat(10)], n, { type: 'application/pdf' });
    return f;
  });
  Object.defineProperty(inp, 'files', { value: files, configurable: true });
  await window.onUploadPicked();
  await tick(window, 30);
}

const rowsOf = (w) => [...w.document.querySelectorAll('tr.doc-row')]
  .map(tr => tr.textContent.replace(/\s+/g, ' ').trim());
const listCalls = (calls) => calls.filter(c => c.url === '/api/documents');
const upFiles = (w) => [...w.document.querySelectorAll('.up-file')]
  .map(el => ({ cls: el.className, text: el.textContent.replace(/\s+/g, ' ').trim() }));

// ─────────────────────────────────────────────────────────────────────────────
// The button
// ─────────────────────────────────────────────────────────────────────────────

describe('the Upload button', () => {
  test('exists in BOTH modes — one file, two modes', async () => {
    const scoped = await boot();
    expect(scoped.window.document.getElementById('upBtnScoped')).toBeTruthy();
    const global = await boot({ query: '' });
    expect(global.window.document.getElementById('upBtnGlobal')).toBeTruthy();
  });

  test('the scoped button is PRIMARY and the global one is not', async () => {
    // On a case tab "put a document on this case" is the action staff came
    // for; on the global page it is one verb among several.
    const { window } = await boot();
    expect(window.document.getElementById('upBtnScoped').className).toMatch(/btn-primary/);
    expect(window.document.getElementById('upBtnGlobal').className).toMatch(/btn-ghost/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The three hops
// ─────────────────────────────────────────────────────────────────────────────

describe('link → Dropbox → commit', () => {
  test('the full flow runs in order and hands the ticket forward', async () => {
    const { window, calls, puts } = await boot();
    await upload(window, ['statement.pdf']);

    const seq = calls.filter(c => c.url.startsWith('/api/documents/upload'));
    expect(seq.map(c => c.url)).toEqual([
      '/api/documents/upload-link', '/api/documents/upload-commit',
    ]);
    // THE HANDOFF: the ticket the server signed comes straight back.
    expect(seq[1].params.ticket).toBe('tkt-for-statement.pdf');
    // The scope rides on the link request; the ticket is what makes it binding.
    expect(seq[0].params).toMatchObject({ case_id: CASE_ID, filename: 'statement.pdf' });
    expect(puts.length).toBe(1);
  });

  test("Dropbox's own id is read from the XHR body and sent to the commit", async () => {
    // THE THING THE TWO CLIENT PAGES THROW AWAY. Every upload commits with
    // autorename, so the path we asked for may now name a DIFFERENT,
    // pre-existing file — committing by path would register the wrong
    // document. The id is the only unambiguous answer and it is in the
    // response body those pages ignore.
    const { window, calls } = await boot();
    await upload(window, ['statement.pdf']);

    const commit = calls.find(c => c.url === '/api/documents/upload-commit');
    expect(commit.params.external_id).toBe('id:LANDED');
  });

  test('the transfer matches the shipped client contract: POST, octet-stream', async () => {
    // Copied from public/docReq.html rather than re-derived — that page has
    // shipped this against real Dropbox for months.
    const { window, puts } = await boot();
    await upload(window, ['statement.pdf']);

    expect(puts[0].method).toBe('POST');
    expect(puts[0].url).toBe('https://content.dropboxapi.com/apitul/1/xyz');
    expect(puts[0].headers['Content-Type']).toBe('application/octet-stream');
  });

  test('an UNPARSEABLE Dropbox body still commits — the bytes landed', async () => {
    // A JSON-parse failure on a 200 is not an upload failure. The server falls
    // back to the path it signed into the ticket.
    const { window, calls } = await boot({ xhr: { body: '<html>proxy</html>' } });
    await upload(window, ['statement.pdf']);

    const commit = calls.find(c => c.url === '/api/documents/upload-commit');
    expect(commit).toBeTruthy();
    expect(commit.params.external_id).toBeUndefined();
  });

  test('a batch uploads SEQUENTIALLY, one link per file', async () => {
    const { window, calls, puts } = await boot();
    await upload(window, ['a.pdf', 'b.pdf', 'c.pdf']);

    const links = calls.filter(c => c.url === '/api/documents/upload-link');
    expect(links.map(c => c.params.filename)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(puts.length).toBe(3);
    expect(calls.filter(c => c.url === '/api/documents/upload-commit').length).toBe(3);
  });

  test('a CONTACT scope sends contact_id, and a GLOBAL upload sends neither', async () => {
    const c = await boot({ query: '?link_type=contact&link_id=1001' });
    await upload(c.window, ['x.pdf']);
    expect(c.calls.find(x => x.url === '/api/documents/upload-link').params)
      .toMatchObject({ contact_id: '1001' });

    const g = await boot({ query: '' });
    await upload(g.window, ['x.pdf']);
    const p = g.calls.find(x => x.url === '/api/documents/upload-link').params;
    expect(p.case_id).toBeUndefined();
    expect(p.contact_id).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure states
// ─────────────────────────────────────────────────────────────────────────────

describe('failures are honest', () => {
  test('a failed TRANSFER leaves NO row and NO commit', async () => {
    // The commit is what creates the document. An optimistic row for a file
    // that does not exist is the one failure mode that would put a lie on
    // screen instead of an error.
    const { window, calls } = await boot({ xhr: { fail: true } });
    await upload(window, ['statement.pdf']);

    expect(calls.find(c => c.url === '/api/documents/upload-commit')).toBeUndefined();
    expect(rowsOf(window)).toEqual([]);
    expect(upFiles(window)[0].cls).toMatch(/err/);
  });

  test('a non-200 from Dropbox is a failure, not a silent success', async () => {
    const { window, calls } = await boot({ xhr: { status: 500 } });
    await upload(window, ['statement.pdf']);
    expect(calls.find(c => c.url === '/api/documents/upload-commit')).toBeUndefined();
    expect(upFiles(window)[0].cls).toMatch(/err/);
  });

  test('a rejected COMMIT (bad ticket) marks the row failed and adds no document', async () => {
    const err = new Error('the upload ticket is invalid or has expired');
    const { window } = await boot({ api: { 'POST /api/documents/upload-commit': err } });
    await upload(window, ['statement.pdf']);

    expect(rowsOf(window)).toEqual([]);
    expect(upFiles(window)[0].text).toMatch(/invalid or has expired/);
  });

  test('the error names the FILE, on its own row — a batch of eight cannot use toasts', async () => {
    let n = 0;
    const { window, toasts } = await boot({
      api: {
        'POST /api/documents/upload-link': (p) => {
          n++;
          if (p.filename === 'b.pdf') return new Error('nope');
          return {
            status: 'success', ticket: 't' + n, link: 'https://db/l',
            path: '/x/' + p.filename, placement: 'case',
          };
        },
      },
    });
    await upload(window, ['a.pdf', 'b.pdf', 'c.pdf']);

    const rows = upFiles(window);
    expect(rows[1].cls).toMatch(/err/);
    expect(rows[1].text).toMatch(/b\.pdf/);
    expect(rows[0].cls).toMatch(/ok/);
    expect(rows[2].cls).toMatch(/ok/);
    expect(toasts).toEqual([]);
  });

  test('ONE failure does not abort the rest of the batch', async () => {
    const { window, calls } = await boot({
      api: {
        'POST /api/documents/upload-link': (p) => p.filename === 'a.pdf'
          ? new Error('nope')
          : { status: 'success', ticket: 't', link: 'https://db/l', path: '/x', placement: 'case' },
      },
    });
    await upload(window, ['a.pdf', 'b.pdf']);
    expect(calls.filter(c => c.url === '/api/documents/upload-commit').length).toBe(1);
  });

  test('the buttons re-enable after the batch, success or not', async () => {
    const { window } = await boot({ xhr: { fail: true } });
    await upload(window, ['a.pdf']);
    expect(window.document.getElementById('upBtnScoped').disabled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The optimistic row
// ─────────────────────────────────────────────────────────────────────────────

describe('the optimistic insert', () => {
  test('a successful upload prepends the row with NO refetch', async () => {
    // Honest rather than merely fast: the default sort is `modified` DESC and
    // a file uploaded four seconds ago IS the newest row, so the top is
    // exactly where a refetch would put it.
    const { window, calls } = await boot({
      responses: [{ documents: [doc(1)], total: 1, limit: 25, offset: 0 }],
    });
    const before = listCalls(calls).length;
    await upload(window, ['statement.pdf']);

    expect(listCalls(calls).length).toBe(before);      // no extra GET
    expect(rowsOf(window).length).toBe(2);
    expect(rowsOf(window)[0]).toMatch(/uploaded\.pdf/);
    expect(window.document.getElementById('scopedCount').textContent).toMatch(/2 documents/);
  });

  test('a batch lands NEWEST-FIRST, matching what a refetch would return', async () => {
    // Not pick order — SORT order. The list is `modified` DESC, and the file
    // uploaded last is the most recently modified, so it belongs at the top.
    // Inserting in pick order would look tidier for about four seconds and
    // then reshuffle itself on the next refresh, which reads as a bug. The
    // `.reverse()` in the insert is what keeps the optimistic view and the
    // server's answer identical.
    let n = 0;
    const { window } = await boot({
      api: {
        'POST /api/documents/upload-commit': () => {
          n++;
          return {
            status: 'success',
            document: doc(900 + n, { name: `up-${n}.pdf` }),
            link_type: 'case', link_id: CASE_ID, relation: 'path',
          };
        },
      },
    });
    await upload(window, ['a.pdf', 'b.pdf', 'c.pdf']);

    const names = rowsOf(window).map(t => (t.match(/up-\d\.pdf/) || [''])[0]);
    expect(names).toEqual(['up-3.pdf', 'up-2.pdf', 'up-1.pdf']);
  });

  test('under a NON-DEFAULT sort it refetches instead of guessing a position', async () => {
    const { window, calls } = await boot({
      responses: [{ documents: [doc(1)], total: 1, limit: 25, offset: 0 }],
    });
    window.onSortChange('name');
    await tick(window, 30);
    const before = listCalls(calls).length;

    await upload(window, ['statement.pdf']);
    expect(listCalls(calls).length).toBe(before + 1);
  });

  test('on PAGE 2 it refetches — the top of this page is not where a new row goes', async () => {
    const { window, calls } = await boot({
      responses: [{ documents: [doc(1)], total: 500, limit: 25, offset: 0 }],
    });
    window.gotoPage(2);
    await tick(window, 30);
    const before = listCalls(calls).length;

    await upload(window, ['statement.pdf']);
    expect(listCalls(calls).length).toBe(before + 1);
  });

  test('a FAILED batch neither prepends nor refetches', async () => {
    const { window, calls } = await boot({ xhr: { fail: true } });
    const before = listCalls(calls).length;
    await upload(window, ['statement.pdf']);
    expect(listCalls(calls).length).toBe(before);
    expect(rowsOf(window)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The bus
// ─────────────────────────────────────────────────────────────────────────────

describe('the sync bus', () => {
  test('the ECHO FENCE stops our own commit costing us a refetch', async () => {
    // /upload-commit announces doclink:case:<id> and THIS frame subscribes to
    // it. Without the linksLastRefresh stamp every upload pays for an extra
    // list GET it already has the answer to.
    const { window, calls } = await boot({
      responses: [{ documents: [doc(1)], total: 1, limit: 25, offset: 0 }],
    });
    const before = listCalls(calls).length;

    await upload(window, ['statement.pdf']);
    await tick(window, 400);          // past the 250ms scheduleRefetch debounce

    expect(listCalls(calls).length).toBe(before);
  });

  test('ANOTHER frame uploading to this case DOES refetch here', async () => {
    // The other half of the fence: it must suppress our own echo without
    // deafening us to a real change made elsewhere. Driven over a real
    // BroadcastChannel between two windows.
    const { window, calls } = await boot({
      responses: [{ documents: [doc(1)], total: 1, limit: 25, offset: 0 }],
    });
    const before = listCalls(calls).length;

    const other = new (require('jsdom').JSDOM)(
      '<!DOCTYPE html><html><body></body></html>',
      { url: 'https://app.4lsg.com/', runScripts: 'dangerously' },
    );
    DOMS.push(other);
    TEARDOWNS.push(bcPolyfill.install(other.window));
    other.window.eval(YCSYNC);

    other.window.YC._sniff('POST', '/api/documents/upload-commit', {
      document: { id: 999 }, link_type: 'case', link_id: CASE_ID, relation: 'path',
    });
    await tick(window, 400);

    expect(listCalls(calls).length).toBe(before + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Harness fences — shared with tests/documentsUi.related.test.js
// ─────────────────────────────────────────────────────────────────────────────

test('HARNESS FENCE: documents.html still touches `location` exactly once', () => {
  // The shadow in boot() is only exact while this holds. S4 edits this page,
  // so the fence is re-asserted here rather than relying on the sibling suite.
  const hits = HTML.match(/\blocation\s*\./g) || [];
  expect(hits.length).toBe(1);
  expect(HTML).toContain('new URLSearchParams(location.search)');
});

test('HARNESS FENCE: the upload input is wired to the handler this suite calls', () => {
  // upload() calls onUploadPicked directly rather than dispatching a change
  // event (jsdom file inputs cannot be populated the normal way), so the
  // MARKUP's binding is not otherwise exercised. Without this, the input could
  // lose its onchange and every test above would still pass.
  expect(HTML).toMatch(/id="upInput"[\s\S]{0,200}onchange="onUploadPicked\(\)"/);
  expect(HTML).toMatch(/onclick="onUploadClick\(\)"/);
});
