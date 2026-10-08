/**
 * @jest-environment node
 *
 * tests/ctaManager.pane.test.js — the Admin → CTA Links pane
 * (public/ctaManager.html; CTA arc, manager-UI slice).
 *
 * BOOTS the real pane in jsdom against a stub shell apiSend and drives it
 * through the DOM. Nothing in the page is stubbed.
 *
 * WHAT IS LOCKED
 *   - Mirrors: the pane re-implements ctaService.deriveState / isStaleRunning
 *     and copies CTA_FN_DENYLIST, STALE_RUNNING_MINUTES and
 *     logService.ABOUT_TYPES as HINTS. Each is compared with the server's own
 *     export here, so a server change that the pane misses fails this suite
 *     instead of mis-colouring a chip or offering a function the dry run
 *     rejects. The builder's function picker is checked against
 *     ctaService.eligibleFunctionNames() over the REAL registry metadata.
 *   - List: chips equal the server's deriveState per row; a derived filter
 *     (expired) asks the server for status=active and filters locally; empty
 *     and error states (the error is the server's own words + Retry).
 *   - Detail: Re-enable is offered exactly when patchCta would allow it.
 *   - Bodies: the PATCH a quick-extend sends (naive FIRM-time datetime,
 *     wall clock kept) and the mint/dry-run body the builder sends.
 *   - §12 clicker inputs (S2i): the inputs editor → declarations + bindings;
 *     the hard rule as a required field; the acknowledge-to-proceed boxes and
 *     what accept_risks carries; the server's mint errors placed under the
 *     field they name; the test-values dry run; submitted inputs in the
 *     detail; Duplicate carrying declarations. Wherever a server answer
 *     matters these run against the REAL routes/api.cta.js + ctaService over
 *     tests/helpers/ctaWorld.js (real JWT + SU elevation), so the error
 *     mapping and the risk boxes are checked against the server's own words.
 *
 * In jsdom a top-level window is its own parent, so window.apiSend IS the
 * pane's P.apiSend (the pane never assigns window.apiSend — no relay loop).
 */

'use strict';

// §12 section boots the REAL /api/cta router (superuserOnlyFor needs a secret).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cta-pane';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { DateTime } = require('luxon');
const ctaService = require('../services/ctaService');
const logService = require('../services/logService');
const internalFunctions = require('../lib/internal_functions');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/ctaManager.html'), 'utf8');
const FIRM_TZ = 'America/Detroit';

const DOMS = [];
afterEach(() => {
  DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } });
});

const tick = (w, ms = 30) => new Promise((r) => w.setTimeout(r, ms));
const H = 3600e3;

function apiError(status, body) {
  const e = new Error(body.message || body.error);
  e.name = 'ApiError'; e.status = status; e.body = body;
  return e;
}

/** A list row in the GET /api/cta shape (ctaService.listCtas + withUrl). */
function row(over = {}) {
  const id = over.id || 1;
  return {
    id, token: `tok${id}`, name: `Link ${id}`, mode: 'once', status: 'active', protection: 'none',
    options: [{ value: 'go', label: 'Go', steps: ['lookup_contact'] }], max_uses: null, uses_count: 0,
    expires_at: new Date(Date.now() + 48 * H).toISOString(), timeout_option: null, failed_attempts: 0,
    return_plan_result: 0, attributed_user_id: null, mint_source: 'su', source_execution_id: null,
    minted_by: 1, link_type: null, link_id: null, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), exec_count: 0, failed_count: 0, last_executed_at: null,
    cta_url: `https://example.com/c/tok${id}`, ...over,
  };
}

/** Full adminRow (GET /api/cta/:id/executions .cta). */
function fullRow(over = {}) {
  const r = row(over);
  delete r.exec_count; delete r.failed_count; delete r.last_executed_at;
  return {
    ...r, prompt: 'Do it?', context_html: null,
    options: [{ value: 'go', label: 'Go', plan: [{ fn: 'lookup_contact', params: { contact_id: '1' } }] }],
    ...over,
  };
}

/**
 * @param {object} o
 * @param {Function} o.handler  (url, method, payload) => response | throws
 */
async function boot({ handler }) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://app.4lsg.com/ctaManager.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};   // not in jsdom
  window.firmData = {
    firmTimezone: FIRM_TZ,
    users: [{ user: 0, user_name: 'automations' }, { user: 1, user_name: 'Alex Admin' }, { user: 2, user_name: 'Sam Staff' }],
  };
  const calls = [];
  window.apiSend = async (url, method = 'GET', payload = null) => {
    calls.push({ url, method, payload: payload == null ? null : JSON.parse(JSON.stringify(payload)) });
    return handler(url, method, payload);
  };

  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  // fence: a second inline block means this harness is stale.
  expect(inline.length).toBe(1);

  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  // A real <script> element, not window.eval: the pane is "use strict", and
  // strict EVAL code gets a private scope — as a classic script (the way the
  // browser runs it) its functions and consts live in the global scope.
  const sc = window.document.createElement('script');
  sc.textContent = inline[0];
  window.document.body.appendChild(sc);
  await tick(window, 60);
  return { window, doc: window.document, calls, errors };
}

const listOnly = (rows) => (url, method) => {
  if (url === '/api/cta' && method === 'GET') return { ctas: rows };
  throw new Error(`unexpected ${method} ${url}`);
};

function setValue(window, el, v, type = 'input') {
  el.value = v;
  el.dispatchEvent(new window.Event(type, { bubbles: true }));
}

// ═════════════════════════════════════════════════════════════════════════════
// Mirrors
// ═════════════════════════════════════════════════════════════════════════════

describe('client mirrors match the server', () => {
  test('deriveState: same answer as ctaService.deriveState over the status × mode × expiry × cap matrix', async () => {
    const { window } = await boot({ handler: listOnly([]) });
    const now = new Date();
    let n = 0;
    for (const status of ['active', 'used', 'disabled', 'cancelled']) {
      for (const mode of ['once', 'repeatable']) {
        for (const exp of [null, new Date(now.getTime() - H), new Date(now.getTime()), new Date(now.getTime() + H)]) {
          for (const [max, uses] of [[null, 0], [null, 9], [3, 2], [3, 3], [3, 4]]) {
            const r = { status, mode, expires_at: exp && exp.toISOString(), max_uses: max, uses_count: uses };
            expect([r, window.deriveState(r, new window.Date(now.getTime()))]).toEqual([r, ctaService.deriveState(r, now)]);
            n++;
          }
        }
      }
    }
    expect(n).toBe(160);
    expect(window.deriveState(null)).toBe(ctaService.deriveState(null));
  });

  test('isStaleRunning: same answer as ctaService.isStaleRunning', async () => {
    const { window } = await boot({ handler: listOnly([]) });
    const now = new Date();
    for (const status of ['running', 'success', 'failed']) {
      for (const ageMin of [1, 14, 16, 120]) {
        const e = { status, executed_at: new Date(now.getTime() - ageMin * 60e3).toISOString() };
        expect([e, window.isStaleRunning(e, new window.Date(now.getTime()))]).toEqual([e, ctaService.isStaleRunning(e, now)]);
      }
    }
    expect(window.isStaleRunning(null)).toBe(false);
  });

  test('denylist, stale window and ABOUT_TYPES equal the server constants', async () => {
    const { window } = await boot({ handler: listOnly([]) });
    expect(window.eval('[...CTA_FN_DENYLIST]').slice().sort()).toEqual([...ctaService.CTA_FN_DENYLIST].sort());
    expect(window.eval('STALE_RUNNING_MINUTES')).toBe(ctaService.STALE_RUNNING_MINUTES);
    expect(window.eval('[...ABOUT_TYPES]')).toEqual([...logService.ABOUT_TYPES]);
  });

  test('builder function picker = ctaService.eligibleFunctionNames() over the real registry', async () => {
    const meta = internalFunctions.__getAllMeta();
    const { window, doc } = await boot({
      handler: (url, method) => {
        if (url === '/api/cta') return { ctas: [] };
        if (url === '/workflows/functions') return { success: true, meta };
        throw new Error(`unexpected ${method} ${url}`);
      },
    });
    doc.getElementById('new-btn').click();
    await tick(window, 60);
    const picker = [...doc.querySelectorAll('#fn-names option')].map((o) => o.value);
    expect(picker).toEqual(ctaService.eligibleFunctionNames());
    expect(picker.length).toBeGreaterThan(20);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// List
// ═════════════════════════════════════════════════════════════════════════════

describe('list', () => {
  const now = Date.now();
  const ROWS = [
    row({ id: 1 }),
    row({ id: 2, status: 'used', uses_count: 1, exec_count: 1, failed_count: 1 }),
    row({ id: 3, expires_at: new Date(now - 5 * H).toISOString() }),
    row({ id: 4, mode: 'repeatable', max_uses: 2, uses_count: 2 }),
    row({ id: 5, status: 'disabled' }),
    row({ id: 6, status: 'cancelled' }),
    row({ id: 7, mint_source: 'workflow', minted_by: 0, source_execution_id: 4321 }),
  ];

  test('one row per link; each chip is the server\'s deriveState for that row', async () => {
    const { doc, errors, calls } = await boot({ handler: listOnly(ROWS) });
    expect(calls[0]).toEqual({ url: '/api/cta', method: 'GET', payload: { limit: 200, offset: 0 } });
    const trs = [...doc.querySelectorAll('#list-region tbody tr.row')];
    expect(trs.map((t) => Number(t.dataset.id))).toEqual(ROWS.map((r) => r.id));
    trs.forEach((tr, i) => {
      expect(tr.querySelector('td:nth-child(2) .badge').textContent).toBe(ctaService.deriveState(ROWS[i]));
    });
    expect(trs[6].textContent).toContain('exec #4321');
    expect(errors).toEqual([]);
  });

  test('derived filter "expired" asks for status=active and keeps only expired rows', async () => {
    const { window, doc, calls } = await boot({ handler: listOnly(ROWS) });
    setValue(window, doc.getElementById('f-status'), 'expired', 'change');
    await tick(window);
    expect(calls[calls.length - 1].payload).toEqual({ limit: 200, offset: 0, status: 'active' });
    const ids = [...doc.querySelectorAll('#list-region tbody tr.row')].map((t) => Number(t.dataset.id));
    expect(ids).toEqual([3]);
  });

  test('stored filter passes through; search matches name or #id', async () => {
    const { window, doc, calls } = await boot({ handler: listOnly(ROWS) });
    setValue(window, doc.getElementById('f-status'), 'disabled', 'change');
    await tick(window);
    expect(calls[calls.length - 1].payload).toEqual({ limit: 200, offset: 0, status: 'disabled' });
    setValue(window, doc.getElementById('f-status'), 'all', 'change');
    await tick(window);
    setValue(window, doc.getElementById('f-q'), '#4');
    expect([...doc.querySelectorAll('#list-region tbody tr.row')].map((t) => t.dataset.id)).toEqual(['4']);
  });

  test('empty state', async () => {
    const { doc } = await boot({ handler: listOnly([]) });
    expect(doc.querySelector('#list-region .empty-row').textContent).toContain('No CTA links yet');
  });

  test('error state carries the server\'s words and a Retry that refetches', async () => {
    let fail = true;
    const { window, doc, calls } = await boot({
      handler: () => {
        if (fail) throw apiError(401, { error: 'Elevation required — confirm your password to use superuser tools.', code: 'elevation_required' });
        return { ctas: [row({ id: 9 })] };
      },
    });
    const box = doc.querySelector('#list-region .inline-error');
    expect(box.textContent).toContain('Elevation required — confirm your password to use superuser tools. (elevation_required)');
    fail = false;
    box.querySelector('[data-act="retry-list"]').click();
    await tick(window);
    expect(calls.length).toBe(2);
    expect(doc.querySelectorAll('#list-region tbody tr.row').length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Detail + PATCH
// ═════════════════════════════════════════════════════════════════════════════

describe('detail', () => {
  async function openDetail(cta, executions, extra) {
    const b = await boot({
      handler: (url, method, payload) => {
        if (url === '/api/cta' && method === 'GET') return { ctas: [row({ id: cta.id, status: cta.status })] };
        if (url === `/api/cta/${cta.id}/executions`) return { cta, executions };
        if (extra) return extra(url, method, payload);
        throw new Error(`unexpected ${method} ${url}`);
      },
    });
    b.doc.querySelector(`#list-region tr.row[data-id="${cta.id}"]`).click();
    await tick(b.window);
    return b;
  }
  const exec = (over) => ({ id: 1, cta_id: 1, option_value: 'go', status: 'failed', plan_result: [{ fn: 'lookup_contact', ok: false, error: 'boom', ms: 3 }],
    responded_via: 'link', responder_user_id: null, responder_ip: '192.0.2.1', executed_at: new Date().toISOString(), ...over });

  test('Re-enable is offered on a used link exactly when patchCta allows it', async () => {
    const cases = [
      [[exec({ status: 'failed' })], true],
      [[exec({ status: 'success' })], false],
      [[exec({ status: 'running' })], false],
      [[exec({ status: 'running', executed_at: new Date(Date.now() - 20 * 60e3).toISOString() })], true],
      [[], false],
    ];
    for (const [execs, offered] of cases) {
      const { doc } = await openDetail(fullRow({ id: 1, status: 'used', uses_count: 1 }), execs);
      const btn = doc.querySelector('#detail-region [data-act="reenable"]');
      expect([execs.map((e) => e.status), !!btn && !btn.disabled]).toEqual([execs.map((e) => e.status), offered]);
    }
  });

  test('cancelled offers only copy + duplicate; disabled adds re-enable, extend and cancel', async () => {
    let { doc } = await openDetail(fullRow({ id: 1, status: 'cancelled' }), []);
    let acts = [...doc.querySelectorAll('#detail-region .btn-row [data-act]')].map((b) => b.dataset.act);
    expect(acts).toEqual(['copy', 'duplicate']);
    ({ doc } = await openDetail(fullRow({ id: 1, status: 'disabled' }), []));
    acts = [...doc.querySelectorAll('#detail-region .btn-row [data-act]')].map((b) => b.dataset.act);
    expect(acts).toEqual(['copy', 'duplicate', 'edit', 'reenable', 'cancel']);
  });

  test('expanding an execution shows each step\'s output and error', async () => {
    const { window, doc } = await openDetail(fullRow({ id: 1, status: 'used', uses_count: 1 }), [exec({
      plan_result: [{ fn: 'lookup_contact', ok: true, output: { contact_email: 'x@example.com' }, ms: 2 },
        { fn: 'send_email', ok: false, error: 'SMTP refused', ms: 9 }],
    })]);
    doc.querySelector('#detail-region tr.row[data-exec="1"]').click();
    await tick(window);
    const d = doc.querySelector('#detail-region tr.exec-detail').textContent;
    expect(d).toContain('"contact_email": "x@example.com"');
    expect(d).toContain('SMTP refused');
    expect(d).toContain('not signed in · IP 192.0.2.1');
  });

  test('+7 days sends a naive FIRM-time expiry 7 calendar days later (wall clock kept); a 409 shows verbatim', async () => {
    // 20 days out at 15:30 firm time; luxon's plus({days}) keeps the wall
    // clock across a DST change exactly as the pane must.
    const exp = DateTime.now().setZone(FIRM_TZ).plus({ days: 20 }).set({ hour: 15, minute: 30, second: 0, millisecond: 0 });
    const naive = (d) => d.toFormat("yyyy-MM-dd'T'HH:mm");
    const cta = fullRow({ id: 1, expires_at: exp.toUTC().toISO() });
    let patched = null;
    const { window, doc } = await openDetail(cta, [], (url, method, payload) => {
      if (url === '/api/cta/1' && method === 'PATCH') {
        patched = payload;
        throw apiError(409, { status: 'error', message: 'cta: the link changed while this PATCH was applied (claimed or edited) — re-read and retry', code: 'conflict' });
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    doc.querySelector('#detail-region [data-act="edit"]').click();
    expect(doc.getElementById('p-exp').value).toBe(naive(exp));
    doc.querySelector('[data-plus="7"]').click();
    doc.getElementById('patch-save').click();
    await tick(window);
    expect(patched).toEqual({ expires_at: naive(exp.plus({ days: 7 })) });
    expect(doc.getElementById('patch-err').textContent)
      .toBe('cta: the link changed while this PATCH was applied (claimed or edited) — re-read and retry (conflict)');
    expect(doc.getElementById('patch-backdrop').classList.contains('open')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Builder
// ═════════════════════════════════════════════════════════════════════════════

describe('mint builder', () => {
  test('dry run sends exactly the draft: parsed params, no password under protection none, no blank optionals', async () => {
    let sent = null;
    const { window, doc } = await boot({
      handler: (url, method, payload) => {
        if (url === '/api/cta' && method === 'GET') return { ctas: [] };
        if (url === '/workflows/functions') return { success: true, meta: {} };
        if (url === '/api/cta' && method === 'POST') {
          sent = payload;
          return { dry_run: true, name: payload.name, mode: 'repeatable', expires_at: new Date().toISOString(), protection: 'none',
            protection_source: 'explicit', options: [], notes: [], warnings: ['w1'], cta_url: 'https://example.com/c/<token>',
            urls: { show: 'https://example.com/c/<token>/show' }, options_html: '', email_html: '<p>hi</p>' };
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    });
    doc.getElementById('new-btn').click();
    await tick(window);
    const $ = (id) => doc.getElementById(id);
    setValue(window, $('m-name'), 'Lookup link');
    setValue(window, $('m-prompt'), 'Show it?');
    setValue(window, $('m-mode'), 'repeatable', 'change');
    setValue(window, $('m-max'), '5');
    setValue(window, $('m-exp-kind'), 'duration', 'change');
    setValue(window, $('m-timeout'), '7d');
    setValue(window, $('m-prot'), 'none', 'change');
    setValue(window, $('o0-label'), 'Show');
    expect($('o0-value').value).toBe('show');           // slug follows the label until edited
    setValue(window, $('o0s0-fn'), 'lookup_contact');
    setValue(window, $('o0s0-params'), '{"contact_id":"1001"}');
    setValue(window, $('o0-tpl'), 'Email: [[1.output.contact_email]]');
    $('dry-btn').click();
    await tick(window);
    expect(sent).toEqual({
      name: 'Lookup link', prompt: 'Show it?', mode: 'repeatable', dry_run: true, max_uses: '5', timeout: '7d', protection: 'none',
      options: [{ value: 'show', label: 'Show', plan: [{ fn: 'lookup_contact', params: { contact_id: '1001' } }],
        result_template: 'Email: [[1.output.contact_email]]' }],
    });
    expect(doc.querySelector('#preview-region .ok-box').textContent).toContain('nothing was created');
    expect(doc.querySelector('#preview-region .warn-box').textContent).toContain('w1');
    const frame = doc.getElementById('email-preview');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.srcdoc).toBe('<p>hi</p>');
  });

  test('unparseable params JSON stops the request client-side', async () => {
    let posted = false;
    const { window, doc } = await boot({
      handler: (url, method) => {
        if (method === 'POST') { posted = true; return {}; }
        if (url === '/api/cta') return { ctas: [] };
        return { success: true, meta: {} };
      },
    });
    doc.getElementById('new-btn').click();
    await tick(window);
    setValue(window, doc.getElementById('o0s0-params'), '{"contact_id": 1,');
    expect(doc.querySelector('[data-json-err="0.0"]').hidden).toBe(false);
    doc.getElementById('dry-btn').click();
    await tick(window);
    expect(posted).toBe(false);
    expect(doc.querySelector('#preview-region .inline-error').textContent).toContain('Option 1, step 1: params is not valid JSON');
  });

  test('a real mint shows the generated password once and asks before leaving it uncopied', async () => {
    const { window, doc } = await boot({
      handler: (url, method, payload) => {
        if (url === '/api/cta' && method === 'GET') return { ctas: [] };
        if (url === '/workflows/functions') return { success: true, meta: {} };
        if (url === '/api/cta' && method === 'POST' && payload.dry_run === false) {
          return { dry_run: false, id: 42, token: 'T'.repeat(22), name: 'X', mode: 'once', expires_at: new Date().toISOString(),
            protection: 'password', protection_source: 'default', options: [], notes: [], warnings: [],
            password: 'Pw'.repeat(11), cta_url: 'https://example.com/c/TTT', urls: {}, options_html: '', email_html: '' };
        }
        throw new Error(`unexpected ${method} ${url}`);
      },
    });
    doc.getElementById('new-btn').click();
    await tick(window);
    doc.getElementById('mint-btn').click();
    expect(doc.getElementById('confirm-backdrop').classList.contains('open')).toBe(true);
    doc.getElementById('confirm-yes').click();
    await tick(window);
    expect(doc.getElementById('view-receipt').hidden).toBe(false);
    expect(doc.getElementById('pw-value').textContent).toBe('Pw'.repeat(11));
    doc.querySelector('[data-act="receipt-list"]').click();
    expect(doc.getElementById('confirm-title').textContent).toContain('without copying the password');
    expect(doc.getElementById('view-receipt').hidden).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// v2 (2026-10-08): timeout option placement, Duplicate, rich copy
// ═════════════════════════════════════════════════════════════════════════════

const NO_FN = (url) => (url === '/workflows/functions' ? { success: true, meta: {} } : undefined);

describe('builder: timeout option', () => {
  test('sits under the options, lists them as "Label (value)", follows label edits, hides for repeatable', async () => {
    const { window, doc } = await boot({ handler: (url, method) => NO_FN(url) || (url === '/api/cta' ? { ctas: [] } : (() => { throw new Error(`unexpected ${method} ${url}`); })()) });
    doc.getElementById('new-btn').click();
    await tick(window);
    const $ = (id) => doc.getElementById(id);
    const sel = () => $('m-timeout-opt');
    const texts = () => [...sel().options].map((o) => o.textContent);
    expect(sel().closest('.form-section').querySelector('h3').textContent).toBe('Options');
    expect($('opts-region').compareDocumentPosition(sel()) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(texts()).toEqual(['— nothing; the link just expires —']);

    setValue(window, $('o0-label'), 'Mark spam');
    expect(texts()[1]).toBe('Mark spam (mark_spam)');
    setValue(window, $('o0-value'), 'spam');                // value now hand-set …
    setValue(window, $('o0-label'), 'Mark as spam');        // … a label edit still relabels the choice
    expect(texts()[1]).toBe('Mark as spam (spam)');

    doc.querySelector('[data-act="add-opt"]').click();
    setValue(window, $('o1-label'), 'Keep');
    expect(texts().slice(1)).toEqual(['Mark as spam (spam)', 'Keep (keep)']);

    setValue(window, $('m-mode'), 'repeatable', 'change');
    expect(sel().closest('.fld').hidden).toBe(true);
  });
});

describe('Duplicate', () => {
  const SRC = () => fullRow({
    id: 5, name: 'Spam check', prompt: 'Is this spam?', context_html: '<p>ctx</p>', mode: 'once', status: 'used',
    timeout_option: 'keep', protection: 'password', return_plan_result: 1, attributed_user_id: 2,
    link_type: 'contact', link_id: '1981', mint_source: 'workflow', minted_by: 0, source_execution_id: 777,
    options: [
      { value: 'spam', label: 'Mark as spam', confirm_text: 'Closes the lead.', result_template: 'Done: [[1.output.task_id]]',
        plan: [{ fn: 'create_task', params: { title: 'Review the spam lead and close it out', assigned_to: 6, send_assignment_email: false, link_type: 'contact', link_id: '1981' } }] },
      { value: 'keep', label: 'Keep', plan: [{ fn: 'lookup_contact', params: { contact_id: '1981' } }, { fn: 'lookup_contact', params: {} }] },
    ],
  });
  const EXPECTED_BODY = () => {
    const c = SRC();
    return {
      name: 'Spam check (copy)', prompt: 'Is this spam?', context_html: '<p>ctx</p>', mode: 'once', dry_run: true,
      timeout_option: 'keep', protection: 'password', return_plan_result: true, attributed_user_id: '2',
      link_type: 'contact', link_id: '1981',
      options: c.options.map((o) => {
        const x = { value: o.value, label: o.label, plan: o.plan };
        if (o.confirm_text) x.confirm_text = o.confirm_text;
        if (o.result_template) x.result_template = o.result_template;
        return x;
      }),
    };
  };
  function handler(counter) {
    return (url, method, payload) => {
      const f = NO_FN(url); if (f) return f;
      if (url === '/api/cta' && method === 'GET') return { ctas: [row({ id: 5, name: 'Spam check', status: 'used' })] };
      if (url === '/api/cta/5/executions') { counter.reads++; return { cta: SRC(), executions: [] }; }
      if (url === '/api/cta' && method === 'POST') { counter.body = payload; return { dry_run: true, options: [], notes: [], warnings: [], urls: {}, email_html: '' }; }
      throw new Error(`unexpected ${method} ${url}`);
    };
  }

  test('from the list: builder pre-filled; the dry run re-sends everything except expiry, password and email template', async () => {
    const n = { reads: 0, body: null };
    const { window, doc } = await boot({ handler: handler(n) });
    doc.querySelector('#list-region tr.row[data-id="5"] [data-act="duplicate"]').click();
    await tick(window);
    expect(doc.getElementById('view-mint').hidden).toBe(false);
    const note = doc.querySelector('#mint-region .info-box').textContent;
    expect(note).toContain('Copied from #5');
    expect(note).toContain('the password (a new one is generated');
    expect(note).toContain('workflow execution #777');
    expect(doc.getElementById('o0-value').value).toBe('spam');
    expect(doc.getElementById('m-timeout-opt').value).toBe('keep');
    expect(doc.getElementById('m-prot').value).toBe('password');
    doc.getElementById('dry-btn').click();
    await tick(window);
    expect(n.body).toEqual(EXPECTED_BODY());
    // label edits must not move a copied value (the copy keeps its URLs' shape)
    setValue(window, doc.getElementById('o1-label'), 'Keep it');
    expect(doc.getElementById('o1-value').value).toBe('keep');
  });

  test('from the detail view: uses the row already loaded (no second read)', async () => {
    const n = { reads: 0, body: null };
    const { window, doc } = await boot({ handler: handler(n) });
    doc.querySelector('#list-region tr.row[data-id="5"]').click();
    await tick(window);
    expect(n.reads).toBe(1);
    doc.querySelector('#detail-region [data-act="duplicate"]').click();
    await tick(window);
    expect(n.reads).toBe(1);
    expect(doc.getElementById('m-name').value).toBe('Spam check (copy)');
  });

  test('over an unminted draft it asks first; Back keeps the draft, Replace swaps it', async () => {
    const n = { reads: 0, body: null };
    const { window, doc } = await boot({ handler: handler(n) });
    doc.getElementById('new-btn').click();
    await tick(window);
    setValue(window, doc.getElementById('m-name'), 'my draft');
    doc.querySelector('#view-mint [data-nav="list"]').click();
    await tick(window);
    doc.querySelector('#list-region tr.row[data-id="5"] [data-act="duplicate"]').click();
    await tick(window);
    expect(doc.getElementById('confirm-title').textContent).toBe('Replace the draft in progress?');
    doc.getElementById('confirm-no').click();
    doc.getElementById('new-btn').click();
    await tick(window);
    expect(doc.getElementById('m-name').value).toBe('my draft');
    doc.querySelector('#view-mint [data-nav="list"]').click();
    doc.querySelector('#list-region tr.row[data-id="5"] [data-act="duplicate"]').click();
    await tick(window);
    doc.getElementById('confirm-yes').click();
    await tick(window);
    expect(doc.getElementById('m-name').value).toBe('Spam check (copy)');
  });

  test('a long name is clipped so "(copy)" still fits the 120-char limit', async () => {
    const { window } = await boot({ handler: listOnly([]) });
    const d = window.draftFromCta({ name: 'x'.repeat(120), options: [] });
    expect(d.name.length).toBe(120);
    expect(d.name.endsWith(' (copy)')).toBe(true);
  });
});

/**
 * Clipboard stand-ins on a booted pane: navigator.clipboard (write/writeText
 * recorded) and an execCommand('copy') shaped like the browser's — with a
 * selection, it fires ONE cancelable 'copy' event (at the selection,
 * bubbling) whose clipboardData collects setData; records what was selected,
 * what was written and whether the default was prevented.
 */
function installCopyStub(b) {
  const { window, doc } = b;
  b.writes = []; b.texts = []; b.copied = [];
  window.ClipboardItem = class { constructor(items) { this.items = items; } };
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { write: async (arr) => { b.writes.push(arr); }, writeText: async (t) => { b.texts.push(t); } },
  });
  b.execResult = true;
  b.fireCopy = true;
  doc.execCommand = (cmd) => {
    const sel = window.getSelection();
    const data = {};
    const box = doc.createElement('div');
    if (sel.rangeCount) box.appendChild(sel.getRangeAt(0).cloneContents());
    const ev = new window.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { setData: (t, v) => { data[t] = v; } } });
    if (b.fireCopy && sel.rangeCount) sel.getRangeAt(0).startContainer.dispatchEvent(ev);
    b.copied.push({ cmd, selected: box.innerHTML, data, prevented: ev.defaultPrevented });
    return b.execResult;
  };
  return b;
}

describe('receipt: rich copy', () => {
  const R = () => ({
    dry_run: false, id: 9, token: 'T'.repeat(22), name: 'X', mode: 'once', expires_at: new Date(Date.now() + 3 * 86400e3).toISOString(),
    protection: 'none', protection_source: 'explicit', options: [{ value: 'go', label: 'Go' }, { value: 'stop', label: 'Stop' }],
    notes: [], warnings: [], cta_url: 'https://example.com/c/TT', urls: { go: 'https://example.com/c/TT/go', stop: 'https://example.com/c/TT/stop' },
    options_html: '<a href="https://example.com/c/TT/go">Go</a><a href="https://example.com/c/TT/stop">Stop</a>',
    email_html: '<!DOCTYPE html><html><body style="background:#f0f4ff;font-family:Arial"><table><tr><td><a href="https://example.com/c/TT/go" onclick="evil()">Go</a></td></tr></table><script>evil()</script></body></html>',
  });
  async function toReceipt() {
    const r = R();
    const b = await boot({
      handler: (url, method) => {
        const f = NO_FN(url); if (f) return f;
        if (url === '/api/cta' && method === 'GET') return { ctas: [] };
        if (url === '/api/cta' && method === 'POST') return r;
        throw new Error(`unexpected ${method} ${url}`);
      },
    });
    const { window, doc } = installCopyStub(b);
    doc.getElementById('new-btn').click();
    await tick(window);
    setValue(window, doc.getElementById('m-prompt'), 'Do it?');
    doc.getElementById('mint-btn').click();
    doc.getElementById('confirm-yes').click();
    await tick(window);
    b.R = r;
    return b;
  }
  const read = (window, blob) => new Promise((res, rej) => { const fr = new window.FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsText(blob); });

  const EMAIL_TEXT = 'Do it?\n\nGo: https://example.com/c/TT/go\nStop: https://example.com/c/TT/stop\n\nAll options: https://example.com/c/TT';

  test('Copy email: the copy event carries BOTH parts — the rendered email as html, "Label: URL" lines as plain text', async () => {
    const b = await toReceipt();
    b.doc.querySelector('[data-act="copy-email"]').click();
    await tick(b.window);
    expect(b.copied).toHaveLength(1);
    const { cmd, selected, data, prevented } = b.copied[0];
    expect(cmd).toBe('copy');
    // a real selection over the rendered email (Safari/Firefox fire copy only over one)
    expect(selected).toContain('<a href="https://example.com/c/TT/go">Go</a>');
    // html part: charset meta + the rendered email — body style on a wrapper, links live, nothing executable
    expect(data['text/html']).toMatch(/^<meta charset="utf-8"><div style="background:#f0f4ff;font-family:Arial">/);
    expect(data['text/html']).toContain('<a href="https://example.com/c/TT/go">Go</a>');
    expect(data['text/html']).not.toMatch(/onclick|<script|evil/);
    // plain part: the links survive a plain-text paste (r1 pasted "GoStop" here)
    expect(data['text/plain'].startsWith(EMAIL_TEXT)).toBe(true);
    expect(prevented).toBe(true);                                           // ours replace the browser's
    expect(b.writes).toEqual([]);
    expect(b.window.getSelection().rangeCount).toBe(0);                     // selection cleared
    expect(b.doc.querySelector('[aria-hidden="true"][style*="-10000px"]')).toBeNull();   // off-screen host removed

    // the handler is gone: a later, ordinary copy is the browser's own
    const later = new b.window.Event('copy', { bubbles: true, cancelable: true });
    const laterData = {};
    Object.defineProperty(later, 'clipboardData', { value: { setData: (t, v) => { laterData[t] = v; } } });
    b.doc.body.dispatchEvent(later);
    expect(laterData).toEqual({});
    expect(later.defaultPrevented).toBe(false);

    b.doc.querySelector('[data-act="copy-buttons"]').click();
    await tick(b.window);
    expect(b.copied[1].data).toEqual({
      'text/html': `<meta charset="utf-8"><div>${b.R.options_html}</div>`,
      'text/plain': 'Go: https://example.com/c/TT/go\nStop: https://example.com/c/TT/stop',
    });
  });

  for (const [why, setup] of [
    ['execCommand refuses', (b) => { b.execResult = false; }],
    ['no copy event fires', (b) => { b.fireCopy = false; }],
  ]) {
    test(`${why} → falls back to ClipboardItem with the same two parts`, async () => {
      const b = await toReceipt();
      setup(b);
      b.doc.querySelector('[data-act="copy-email"]').click();
      await tick(b.window);
      expect(b.writes).toHaveLength(1);
      const item = b.writes[0][0].items;
      expect(await read(b.window, item['text/html'])).toBe(b.R.email_html);
      expect((await read(b.window, item['text/plain'])).startsWith(EMAIL_TEXT)).toBe(true);
      expect(b.doc.getElementById('toast').textContent).toBe('Email copied — paste it into the message body');
    });
  }

  test('copy text / HTML source stay raw text copies', async () => {
    const b = await toReceipt();
    for (const act of ['copy-email-text', 'copy-email-src', 'copy-buttons-src']) b.doc.querySelector(`[data-act="${act}"]`).click();
    await tick(b.window);
    expect(b.texts[0].startsWith('Do it?\n\nGo: https://example.com/c/TT/go')).toBe(true);
    expect(b.texts.slice(1)).toEqual([b.R.email_html, b.R.options_html]);
  });
});

describe('detail: the Email block (r3 — copy after the receipt is gone)', () => {
  const LINKS = {
    urls: { go: 'https://example.com/c/tok1/go', stop: 'https://example.com/c/tok1/stop' },
    options_html: '<a href="https://example.com/c/tok1/go">Go</a><a href="https://example.com/c/tok1/stop">Stop</a>',
    email_html: '<!DOCTYPE html><html><body style="background:#f0f4ff"><p>DEFAULT EMAIL</p><a href="https://example.com/c/tok1/go">Go</a></body></html>',
  };
  const CTA = (over = {}) => fullRow({
    id: 1, prompt: 'Approve it?',
    options: [{ value: 'go', label: 'Go', plan: [] }, { value: 'stop', label: 'Stop', plan: [] }],
    ...over,
  });
  async function toDetail({ cta = CTA(), links = LINKS, executions = [] } = {}) {
    const b = await boot({
      handler: (url, method) => {
        const f = NO_FN(url); if (f) return f;
        if (url === '/api/cta' && method === 'GET') return { ctas: [row({ id: 1, status: cta.status, expires_at: cta.expires_at })] };
        if (url === '/api/cta/1/executions') return { cta, executions, links };
        throw new Error(`unexpected ${method} ${url}`);
      },
    });
    installCopyStub(b);
    b.doc.querySelector('#list-region tr.row[data-id="1"]').click();
    await tick(b.window);
    b.block = () => [...b.doc.querySelectorAll('#detail-region .section')].find((x) => x.querySelector('h3') && x.querySelector('h3').textContent === 'Email');
    return b;
  }
  const TEXT = 'Approve it?\n\nGo: https://example.com/c/tok1/go\nStop: https://example.com/c/tok1/stop\n\nAll options: https://example.com/c/tok1';

  test('an active link: Copy email / Copy buttons from the read\'s links — both parts, the prompt and URLs from the row', async () => {
    const b = await toDetail();
    const block = b.block();
    expect(block).toBeTruthy();
    expect(block.querySelector('[data-act="send"]')).toBeNull();                 // Send… stays in the action row (one button)
    expect(b.doc.querySelectorAll('#detail-region [data-act="send"]')).toHaveLength(1);
    expect(block.textContent).toContain("a custom template used at mint isn't stored");

    block.querySelector('[data-act="copy-email"]').click();
    await tick(b.window);
    expect(b.copied[0].data['text/html']).toMatch(/^<meta charset="utf-8"><div style="background:#f0f4ff"><p>DEFAULT EMAIL<\/p>/);
    expect(b.copied[0].data['text/plain'].startsWith(TEXT)).toBe(true);
    expect(b.doc.getElementById('toast').textContent).toBe('Email copied — paste it into the message body');

    block.querySelector('[data-act="copy-buttons"]').click();
    await tick(b.window);
    expect(b.copied[1].data).toEqual({
      'text/html': `<meta charset="utf-8"><div>${LINKS.options_html}</div>`,
      'text/plain': 'Go: https://example.com/c/tok1/go\nStop: https://example.com/c/tok1/stop',
    });

    for (const act of ['copy-email-text', 'copy-email-src', 'copy-buttons-src']) block.querySelector(`[data-act="${act}"]`).click();
    await tick(b.window);
    expect(b.texts[0].startsWith(TEXT)).toBe(true);
    expect(b.texts.slice(1)).toEqual([LINKS.email_html, LINKS.options_html]);
  });

  test('the preview: sandboxed, folded by default, painted with the read\'s email — and stays open across a re-render', async () => {
    const b = await toDetail({
      executions: [{ id: 5, option_value: 'go', status: 'success', responded_via: 'link', executed_at: new Date().toISOString(), plan_result: [] }],
    });
    const box = b.doc.querySelector('#detail-region details.email-preview-box');
    expect(box.open).toBe(false);
    const f = b.doc.getElementById('detail-email');
    expect(f.getAttribute('sandbox')).toBe('');
    expect(f.srcdoc).toBe(LINKS.email_html);
    box.open = true;
    box.dispatchEvent(new b.window.Event('toggle'));
    b.doc.querySelector('#detail-region tr.row[data-exec="5"]').click();           // re-renders the whole detail
    const again = b.doc.querySelector('#detail-region details.email-preview-box');
    expect(again).not.toBe(box);
    expect(again.open).toBe(true);
    expect(b.doc.getElementById('detail-email').srcdoc).toBe(LINKS.email_html);  // the fresh frame is painted too
  });

  test('no block when the link is not active, or the read carried no links', async () => {
    let b = await toDetail({ cta: CTA({ status: 'used', uses_count: 1 }), links: null });
    expect(b.block()).toBeUndefined();
    b = await toDetail({ cta: CTA({ status: 'used', uses_count: 1 }) });           // even if links came back, a dead link gets none
    expect(b.block()).toBeUndefined();
    b = await toDetail({ links: null });
    expect(b.block()).toBeUndefined();
    expect(b.doc.querySelector('#detail-region [data-act="copy-email"]')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Send dialog (send slice, 2026-10-08) — POST /api/cta/:id/send
// ═════════════════════════════════════════════════════════════════════════════

describe('Send dialog', () => {
  async function boot2({ cta, sendImpl, listRow = null, open = true }) {
    const calls = [];
    const b = await boot({
      handler: (url, method, payload) => {
        const f = NO_FN(url); if (f) return f;
        if (url === '/api/cta' && method === 'GET') return { ctas: [listRow || row({ id: cta.id, status: cta.status, expires_at: cta.expires_at })] };
        if (url === `/api/cta/${cta.id}/executions`) return { cta, executions: [] };
        if (url === `/api/cta/${cta.id}/send`) { calls.push(payload); return sendImpl(payload); }
        throw new Error(`unexpected ${method} ${url}`);
      },
    });
    b.window.firmData.emailFrom = [{ email: 'office@example.com', from_name: 'Office' }];
    b.window.firmData.phoneLines = [{ phone_number: '5555550100', display_name: 'Main Line' }];
    b.sendCalls = calls;
    if (open) {
      b.doc.querySelector(`#list-region tr.row[data-id="${cta.id}"]`).click();
      await tick(b.window);
    }
    return b;
  }
  const pickSms = (window, doc) => {
    const sms = doc.querySelector('input[name="s-ch"][value="sms"]');
    sms.checked = true;
    sms.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const OK = (p) => (p.dry_run
    ? (p.channel === 'sms' ? { dry_run: true, channel: 'sms', from: '5555550100', text: 'Do it?\nRespond: https://example.com/c/tok1' }
      : { dry_run: true, channel: 'email', from: 'automations@example.com', subject: 'Action requested: Do it?', html: '<p>EMAIL</p>', template: 'default' })
    : { sent: true, channel: p.channel, to: p.to, from: 'x', template: 'default', log_id: 7 });

  test('offered on active links only', async () => {
    let b = await boot2({ cta: fullRow({ id: 1 }), sendImpl: OK });
    expect(b.doc.querySelector('#detail-region [data-act="send"]')).not.toBeNull();
    b = await boot2({ cta: fullRow({ id: 1, status: 'used', uses_count: 1 }), sendImpl: OK });
    expect(b.doc.querySelector('#detail-region [data-act="send"]')).toBeNull();
    b = await boot2({ cta: fullRow({ id: 1, expires_at: new Date(Date.now() - H).toISOString() }), sendImpl: OK });
    expect(b.doc.querySelector('#detail-region [data-act="send"]')).toBeNull();
  });

  test('email with defaults sends only {channel, to}; closes; toast names the log', async () => {
    const { window, doc, sendCalls } = await boot2({ cta: fullRow({ id: 1 }), sendImpl: OK });
    doc.querySelector('#detail-region [data-act="send"]').click();
    expect(doc.getElementById('send-backdrop').classList.contains('open')).toBe(true);
    doc.getElementById('send-go').click();
    await tick(window);
    expect(sendCalls).toEqual([]);                          // no recipient → client-side stop
    expect(doc.getElementById('send-err').textContent).toBe('Enter the email address to send to.');
    setValue(window, doc.getElementById('s-to'), 'ss@example.com');
    doc.getElementById('send-go').click();
    await tick(window);
    expect(sendCalls).toEqual([{ channel: 'email', to: 'ss@example.com' }]);
    expect(doc.getElementById('send-backdrop').classList.contains('open')).toBe(false);
    expect(doc.getElementById('toast').textContent).toBe('Sent by email to ss@example.com — logged on the link');
  });

  test('email extras go up; switching to SMS drops subject/template and lists the phone lines', async () => {
    const { window, doc, sendCalls } = await boot2({ cta: fullRow({ id: 1 }), sendImpl: OK });
    doc.querySelector('#detail-region [data-act="send"]').click();
    setValue(window, doc.getElementById('s-to'), 'ss@example.com');
    setValue(window, doc.getElementById('s-from'), 'office@example.com', 'change');
    setValue(window, doc.getElementById('s-subject'), 'Quick one');
    setValue(window, doc.getElementById('s-tpl-kind'), 'custom', 'change');
    setValue(window, doc.getElementById('s-tpl'), '<p>[[options_html]]</p>');
    doc.getElementById('send-go').click();
    await tick(window);
    expect(sendCalls[0]).toEqual({ channel: 'email', to: 'ss@example.com', from: 'office@example.com', subject: 'Quick one', email_template: '<p>[[options_html]]</p>' });

    doc.querySelector('#detail-region [data-act="send"]').click();
    // typed in email mode, then the channel switches: none of it may reach an SMS
    setValue(window, doc.getElementById('s-subject'), 'Quick one');
    setValue(window, doc.getElementById('s-tpl-kind'), 'custom', 'change');
    setValue(window, doc.getElementById('s-tpl'), '<p>x</p>');
    const sms = doc.querySelector('input[name="s-ch"][value="sms"]');
    sms.checked = true;
    sms.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect([...doc.querySelectorAll('#s-from option')].map((o) => o.value)).toEqual(['', '5555550100']);
    expect(doc.querySelector('#send-body [data-email-only]').hidden).toBe(true);
    setValue(window, doc.getElementById('s-to'), '3135550199');
    setValue(window, doc.getElementById('s-from'), '5555550100', 'change');
    doc.getElementById('send-go').click();
    await tick(window);
    expect(sendCalls[1]).toEqual({ channel: 'sms', to: '3135550199', from: '5555550100' });
  });

  test('Preview is a dry run: sandboxed email preview / SMS text; nothing marked sent', async () => {
    const { window, doc, sendCalls } = await boot2({ cta: fullRow({ id: 1 }), sendImpl: OK });
    doc.querySelector('#detail-region [data-act="send"]').click();
    doc.getElementById('send-preview').click();
    await tick(window);
    expect(sendCalls[0]).toEqual({ channel: 'email', dry_run: true });
    const f = doc.getElementById('send-email-preview');
    expect(f.getAttribute('sandbox')).toBe('');
    expect(f.srcdoc).toBe('<p>EMAIL</p>');
    expect(doc.getElementById('send-backdrop').classList.contains('open')).toBe(true);
    const sms = doc.querySelector('input[name="s-ch"][value="sms"]');
    sms.checked = true;
    sms.dispatchEvent(new window.Event('change', { bubbles: true }));
    doc.getElementById('send-preview').click();
    await tick(window);
    expect(sendCalls[1]).toEqual({ channel: 'sms', dry_run: true });
    expect(doc.querySelector('#send-preview-region .sms-preview').textContent).toBe('Do it?\nRespond: https://example.com/c/tok1');
  });

  test('a server refusal (409) shows verbatim and the dialog stays open', async () => {
    const { window, doc } = await boot2({
      cta: fullRow({ id: 1 }),
      sendImpl: () => { throw apiError(409, { status: 'error', message: 'cta: only an active link can be sent — CTA 1 is used', code: 'not_active' }); },
    });
    doc.querySelector('#detail-region [data-act="send"]').click();
    setValue(window, doc.getElementById('s-to'), 'ss@example.com');
    doc.getElementById('send-go').click();
    await tick(window);
    expect(doc.getElementById('send-err').textContent).toBe('cta: only an active link can be sent — CTA 1 is used (not_active)');
    expect(doc.getElementById('send-backdrop').classList.contains('open')).toBe(true);
  });

  test('from the receipt: Send… offers the custom template used at mint (it is stored nowhere else)', async () => {
    const sent = [];
    const { window, doc } = await boot({
      handler: (url, method, payload) => {
        const f = NO_FN(url); if (f) return f;
        if (url === '/api/cta' && method === 'GET') return { ctas: [] };
        if (url === '/api/cta' && method === 'POST') {
          return { dry_run: false, id: 42, token: 'T'.repeat(22), name: 'X', mode: 'once', expires_at: new Date(Date.now() + 86400e3).toISOString(),
            protection: 'none', protection_source: 'explicit', options: [], notes: [], warnings: [], cta_url: 'https://example.com/c/TTT',
            urls: {}, options_html: '', email_html: '' };
        }
        if (url === '/api/cta/42/send') { sent.push(payload); return { sent: true, channel: 'email', to: payload.to, log_id: null }; }
        throw new Error(`unexpected ${method} ${url}`);
      },
    });
    doc.getElementById('new-btn').click();
    await tick(window);
    setValue(window, doc.getElementById('m-email'), '<p>Mine: [[options_html]]</p>');
    doc.getElementById('mint-btn').click();
    doc.getElementById('confirm-yes').click();
    await tick(window);
    doc.querySelector('#receipt-region [data-act="send"]').click();
    expect(doc.getElementById('s-tpl-kind').value).toBe('custom');
    expect(doc.getElementById('s-tpl').value).toBe('<p>Mine: [[options_html]]</p>');
    setValue(window, doc.getElementById('s-to'), 'ss@example.com');
    doc.getElementById('send-go').click();
    await tick(window);
    expect(sent).toEqual([{ channel: 'email', to: 'ss@example.com', email_template: '<p>Mine: [[options_html]]</p>' }]);
    expect(doc.getElementById('toast').textContent).toBe('Sent by email to ss@example.com');
  });

  test('a password-protected link warns that the password is never included', async () => {
    const { doc } = await boot2({ cta: fullRow({ id: 1, protection: 'password' }), sendImpl: OK });
    doc.querySelector('#detail-region [data-act="send"]').click();
    expect(doc.querySelector('#send-body .warn-box').textContent).toContain('never');
  });

  describe('editable SMS (r2)', () => {
    const PROMPT = 'Approve   the amended\nschedules?';
    const DEFAULT = 'Approve the amended schedules?\nRespond: [[cta_url]]';

    test('pre-filled with the default in token form; untouched or emptied sends no sms_text; Reset restores it', async () => {
      const { window, doc, sendCalls } = await boot2({ cta: fullRow({ id: 1, prompt: PROMPT }), sendImpl: OK });
      doc.querySelector('#detail-region [data-act="send"]').click();
      expect(doc.querySelector('#send-body [data-sms-only]').hidden).toBe(true);      // email first
      pickSms(window, doc);
      expect(doc.querySelector('#send-body [data-sms-only]').hidden).toBe(false);
      expect(doc.getElementById('s-sms').value).toBe(DEFAULT);
      setValue(window, doc.getElementById('s-to'), '3135550199');
      doc.getElementById('send-go').click();
      await tick(window);
      expect(sendCalls[0]).toEqual({ channel: 'sms', to: '3135550199' });

      doc.querySelector('#detail-region [data-act="send"]').click();
      pickSms(window, doc);
      setValue(window, doc.getElementById('s-to'), '3135550199');
      setValue(window, doc.getElementById('s-sms'), '   ');
      doc.getElementById('send-go').click();
      await tick(window);
      expect(sendCalls[1]).toEqual({ channel: 'sms', to: '3135550199' });

      doc.querySelector('#detail-region [data-act="send"]').click();
      pickSms(window, doc);
      setValue(window, doc.getElementById('s-sms'), 'changed [[cta_url]]');
      doc.querySelector('#send-body [data-act="sms-reset"]').click();
      expect(doc.getElementById('s-sms').value).toBe(DEFAULT);
    });

    test('an edited text goes up as sms_text — for preview and send — and never rides an email', async () => {
      const { window, doc, sendCalls } = await boot2({ cta: fullRow({ id: 1, prompt: PROMPT }), sendImpl: OK });
      doc.querySelector('#detail-region [data-act="send"]').click();
      pickSms(window, doc);
      setValue(window, doc.getElementById('s-to'), '3135550199');
      setValue(window, doc.getElementById('s-sms'), 'Stuart — spam? [[respond_url:go]]');
      doc.getElementById('send-preview').click();
      await tick(window);
      expect(sendCalls[0]).toEqual({ channel: 'sms', to: '3135550199', sms_text: 'Stuart — spam? [[respond_url:go]]', dry_run: true });
      doc.getElementById('send-go').click();
      await tick(window);
      expect(sendCalls[1]).toEqual({ channel: 'sms', to: '3135550199', sms_text: 'Stuart — spam? [[respond_url:go]]' });

      doc.querySelector('#detail-region [data-act="send"]').click();
      pickSms(window, doc);
      setValue(window, doc.getElementById('s-sms'), 'edited [[cta_url]]');
      const email = doc.querySelector('input[name="s-ch"][value="email"]');
      email.checked = true;
      email.dispatchEvent(new window.Event('change', { bubbles: true }));
      setValue(window, doc.getElementById('s-to'), 'ss@example.com');
      doc.getElementById('send-go').click();
      await tick(window);
      expect(sendCalls[2]).toEqual({ channel: 'email', to: 'ss@example.com' });
    });

    test('a server refusal of the text (no link) shows verbatim; nothing closes', async () => {
      const { window, doc } = await boot2({
        cta: fullRow({ id: 1 }),
        sendImpl: () => { throw apiError(400, { status: 'error', message: 'cta: sms_text: the SMS must carry the link — keep [[cta_url]] or a [[respond_url:VALUE]] in it', code: 'invalid' }); },
      });
      doc.querySelector('#detail-region [data-act="send"]').click();
      pickSms(window, doc);
      setValue(window, doc.getElementById('s-to'), '3135550199');
      setValue(window, doc.getElementById('s-sms'), 'call me');
      doc.getElementById('send-go').click();
      await tick(window);
      expect(doc.getElementById('send-err').textContent).toBe('cta: sms_text: the SMS must carry the link — keep [[cta_url]] or a [[respond_url:VALUE]] in it');
      expect(doc.getElementById('send-backdrop').classList.contains('open')).toBe(true);
    });
  });

  describe('Send… from the list row (r2)', () => {
    test('offered on active rows only', async () => {
      let b = await boot2({ cta: fullRow({ id: 1 }), sendImpl: OK, open: false });
      expect(b.doc.querySelector('#list-region tr.row[data-id="1"] [data-act="send"]')).not.toBeNull();
      b = await boot2({ cta: fullRow({ id: 1, status: 'disabled' }), sendImpl: OK, open: false });
      expect(b.doc.querySelector('#list-region tr.row[data-id="1"] [data-act="send"]')).toBeNull();
      b = await boot2({ cta: fullRow({ id: 1, expires_at: new Date(Date.now() - H).toISOString() }), sendImpl: OK, open: false });
      expect(b.doc.querySelector('#list-region tr.row[data-id="1"] [data-act="send"]')).toBeNull();
    });

    test('reads the link, lands on its detail with the dialog open (prompt from the read); closing leaves the detail', async () => {
      const { window, doc, calls } = await boot2({ cta: fullRow({ id: 1, prompt: 'From the row read?' }), sendImpl: OK, open: false });
      doc.querySelector('#list-region tr.row[data-id="1"] [data-act="send"]').click();
      await tick(window);
      expect(calls.filter((c) => c.url === '/api/cta/1/executions')).toHaveLength(1);
      expect(doc.getElementById('view-detail').hidden).toBe(false);
      expect(doc.getElementById('send-backdrop').classList.contains('open')).toBe(true);
      pickSms(window, doc);
      expect(doc.getElementById('s-sms').value).toBe('From the row read?\nRespond: [[cta_url]]');
      doc.getElementById('send-close').click();
      expect(doc.getElementById('view-detail').hidden).toBe(false);
      // an ordinary row click later does NOT pop the dialog
      doc.querySelector('[data-nav="list"]').click();
      doc.querySelector('#list-region tr.row[data-id="1"]').click();
      await tick(window);
      expect(doc.getElementById('send-backdrop').classList.contains('open')).toBe(false);
    });

    test('a stale row (active in the list, used by the time it is read): no dialog, says why', async () => {
      const { window, doc } = await boot2({
        cta: fullRow({ id: 1, status: 'used', uses_count: 1 }), sendImpl: OK, open: false, listRow: row({ id: 1 }),
      });
      doc.querySelector('#list-region tr.row[data-id="1"] [data-act="send"]').click();
      await tick(window);
      expect(doc.getElementById('send-backdrop').classList.contains('open')).toBe(false);
      expect(doc.getElementById('toast').textContent).toBe("Can't send — this link is used now");
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §12 clicker inputs (S2i) — the REAL mint route wherever the answer matters
// ═════════════════════════════════════════════════════════════════════════════

describe('clicker inputs (§12, S2i)', () => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const firmConfig = require('../lib/firmConfig');
  const { mintElevationToken, _resetRateLimits } = require('../lib/auth.superuser');
  const { makeCtaWorld } = require('./helpers/ctaWorld');
  const SU_ID = 6;   // 'authorized - SU' in the world
  const META = internalFunctions.__getAllMeta();

  const SRV = { db: null, base: null, server: null };
  beforeAll((done) => {
    process.env.LANDING_HOSTS = '4lsg.com';
    firmConfig._test({ resetCache: true });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = SRV.db; next(); });
    app.use(require('../routes/api.cta'));
    SRV.server = app.listen(0, '127.0.0.1', () => { SRV.base = `http://127.0.0.1:${SRV.server.address().port}`; done(); });
  });
  afterAll((done) => {
    delete process.env.LANDING_HOSTS;
    firmConfig._test({ resetCache: true });
    if (SRV.server.closeAllConnections) SRV.server.closeAllConnections();
    SRV.server.close(done);
  });
  beforeEach(() => { SRV.db = makeCtaWorld(); _resetRateLimits(); });

  const staffToken = () => jwt.sign(
    { sub: SU_ID, username: 'fred', user_type: 'staff', user_auth: 'authorized - SU', aud: 'staff', roles: [] },
    process.env.JWT_SECRET, { expiresIn: '1h' });
  /** One call to the real routes/api.cta.js, as the shell's apiSend would make it (JWT + elevation; non-2xx throws its body). */
  async function real(url, method, payload) {
    const res = await fetch(SRV.base + url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${staffToken()}`, 'x-su-elevation': mintElevationToken(SU_ID) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(payload || {}) }),
    });
    const body = await res.json();
    if (!res.ok) throw apiError(res.status, body);
    return body;
  }
  /** The pane with the REAL registry metadata and the REAL mint route; `extra` answers anything else first. */
  const realHandler = (extra) => async (url, method, payload) => {
    if (extra) { const r = await extra(url, method, payload); if (r !== undefined) return r; }
    if (url === '/workflows/functions') return { success: true, meta: META };
    if (url === '/api/cta' && method === 'GET') return { ctas: [] };
    if (url === '/api/cta' && method === 'POST') return real(url, method, payload);
    throw new Error(`unexpected ${method} ${url}`);
  };
  const posts = (calls) => calls.filter((c) => c.url === '/api/cta' && c.method === 'POST').map((c) => c.payload);

  async function openBuilder(handler) {
    const b = await boot({ handler });
    b.doc.getElementById('new-btn').click();
    await tick(b.window, 60);
    return b;
  }
  /** Click Preview and wait for every request it makes (a second one for test values). */
  async function dry(b) {
    b.doc.getElementById('dry-btn').click();
    for (let i = 0; i < 200 && b.window.eval('state.minting'); i++) await tick(b.window, 15);
    await tick(b.window, 10);
  }
  /** Put a draft straight into the builder — for cases where the server's verdict is the point, not the typing. */
  async function injectDraft(window, spec) {
    window.__spec = JSON.parse(JSON.stringify(spec));
    window.eval(`(() => {
      const s = window.__spec;
      const d = newDraft();
      Object.assign(d, s.top || {});
      d.options = s.options.map((o) => ({
        ...newOption(), valueTouched: true, ...o,
        inputs: (o.inputs || []).map((i) => ({ ...newInput(), nameTouched: true, maxlenTouched: true, ...i })),
        steps: o.steps.map((st) => ({ fn: st.fn, params: JSON.stringify(st.params) })),
      }));
      state.draft = d;
      rerenderMint();
    })()`);
    await tick(window);
  }

  const PHONE = { name: 'to', label: 'Phone', type: 'phone', maxlen: '16' };
  const TEXT = { name: 'msg', label: 'Msg', type: 'text', maxlen: '100' };
  const HTML_IN = { name: 'msg', label: 'Msg', type: 'html', maxlen: '100' };
  const SMS = { fn: 'send_sms', params: { from: '2485559999', to: '[[input:to]]', message: '[[input:msg]]' } };
  const LOGM = (n = 'msg') => ({ fn: 'create_log', params: { type: 'note', message: `[[input:${n}]]` } });
  const ONE = (inputs, steps, top = {}, opt = {}) => ({
    top: { name: 'Inputs link', prompt: 'Tell us', protection: 'none', ...top },
    options: [{ value: 'go', label: 'Go', inputs, steps, ...opt }],
  });

  test('mirrors: risk codes, input types and every opened param equal the server\'s; declaration limits behave like the mint', async () => {
    const { window } = await openBuilder(realHandler());
    expect(Object.keys(window.eval('RISK_COPY')).sort()).toEqual(Object.keys(ctaService.CTA_RISKS).sort());
    expect(window.eval('[...INPUT_TYPES]')).toEqual([...ctaService.INPUT_TYPES]);
    const opened = JSON.parse(window.eval(`(() => {
      const out = {};
      for (const fn of eligibleNames()) {
        const ps = openedParams(fn);
        if (!ps.length) continue;
        out[fn] = {};
        for (const { param, spec } of ps) out[fn][param] = { kind: spec.kind, ...(spec.html ? { html: true } : {}), ...(spec.type ? { type: spec.type } : {}) };
      }
      return JSON.stringify(out);
    })()`));
    expect(opened).toEqual(ctaService.openedInputParams());

    const accepts = async (inputs, steps = inputs.map((d) => LOGM(d.name))) => {
      try {
        await ctaService.mintCta(makeCtaWorld(), {
          name: 'n', prompt: 'p', minted_by: SU_ID, protection: 'none', dry_run: true,
          options: [{ value: 'go', label: 'Go', inputs, plan: steps }],
        });
        return true;
      } catch (e) {
        if (!(e instanceof ctaService.CtaError)) throw e;
        return false;
      }
    };
    const okName = window.eval('(n) => INPUT_NAME_RE.test(n) && !RESERVED_INPUT_NAMES.includes(n)');
    for (const name of ['a', '_x', 'A1_b', '1a', 'a-b', 'x'.repeat(64), 'x'.repeat(65), '__proto__', 'constructor', 'prototype']) {
      expect([name, okName(name)]).toEqual([name, await accepts([{ name, label: 'L', type: 'text', required: true, maxlen: 10 }])]);
    }
    const D = (over) => ({ name: 'v', label: 'L', type: 'text', required: true, maxlen: 10, ...over });
    for (const [type, floor] of Object.entries(window.eval('({ ...MIN_MAXLEN })'))) {
      expect([type, await accepts([D({ type, maxlen: floor })]), await accepts([D({ type, maxlen: floor - 1 })])]).toEqual([type, true, false]);
    }
    for (const [type, len] of Object.entries(window.eval('({ ...FIXED_MAXLEN })'))) {   // the lengths the pane fixes are mintable
      expect([type, await accepts([D({ type, maxlen: Number(len), ...(type === 'enum' ? { choices: ['a'] } : {}) })])]).toEqual([type, true]);
    }
    const cap = window.eval('MAX_INPUT_LEN');
    expect([await accepts([D({ maxlen: cap })]), await accepts([D({ maxlen: cap + 1 })])]).toEqual([true, false]);
    const pat = window.eval('MAX_PATTERN');
    expect([await accepts([D({ maxlen: 200, pattern: 'a'.repeat(pat) })]), await accepts([D({ maxlen: 200, pattern: 'a'.repeat(pat + 1) })])]).toEqual([true, false]);
    const ch = window.eval('MAX_CHOICES');
    const choices = (n) => Array.from({ length: n }, (_, i) => `c${i}`);
    expect([await accepts([D({ type: 'enum', choices: choices(ch) })]), await accepts([D({ type: 'enum', choices: choices(ch + 1) })])]).toEqual([true, false]);
    const max = window.eval('MAX_INPUTS');
    const many = (n) => Array.from({ length: n }, (_, i) => D({ name: `v${i}` }));
    expect([await accepts(many(max)), await accepts(many(max + 1))]).toEqual([true, false]);
  });

  test('editor → declarations, "Bind to" writes the binding, the real dry run passes and names the protection default', async () => {
    const b = await openBuilder(realHandler());
    const { window, doc, calls, errors } = b;
    const $ = (id) => doc.getElementById(id);
    setValue(window, $('m-name'), 'Text a client');
    setValue(window, $('m-prompt'), 'Send a reminder?');
    setValue(window, $('o0-label'), 'Text them');
    setValue(window, $('o0s0-fn'), 'send_sms');
    setValue(window, $('o0s0-params'), '{"from":"2485559999"}');
    // the step says, in words, which of its params a clicker can fill
    expect(doc.querySelector('[data-fn-desc="0.0"]').textContent)
      .toContain('Clicker inputs can fill: message (what it says — any input) · to (who receives it — a Phone number input)');

    doc.querySelector('.opt-card[data-oi="0"] [data-act="in-add"]').click();
    await tick(window);
    setValue(window, $('o0i0-label'), 'Mobile number');
    expect($('o0i0-name').value).toBe('mobile_number');           // the name follows the label until edited
    setValue(window, $('o0i0-type'), 'phone', 'change');
    expect($('o0i0-maxlen')).toBeNull();                          // a phone's length is fixed by the pane
    expect($('o0i0-used').textContent).toContain('Not bound yet');
    expect([...$('o0i0-bind').options].map((o) => o.textContent))
      .toEqual(['Choose a step param…', 'Step 1 · send_sms.message — content', 'Step 1 · send_sms.to — recipient · phone']);
    setValue(window, $('o0i0-bind'), '0|to', 'change');
    expect(JSON.parse($('o0s0-params').value)).toEqual({ from: '2485559999', to: '[[input:mobile_number]]' });
    expect($('o0i0-used').textContent).toBe('Bound to step 1 send_sms.to.');
    setValue(window, $('o0i0-label'), 'Cell');
    expect($('o0i0-name').value).toBe('mobile_number');           // bound → the name stays put
    const nameErr = () => doc.querySelector('[data-name-err="0.0"]');
    setValue(window, $('o0i0-name'), '9lives');
    expect([nameErr().hidden, nameErr().textContent]).toEqual([false, 'Not a valid name.']);
    expect($('o0i0-used').textContent).toContain('Not bound yet');   // the binding names the old name
    setValue(window, $('o0i0-name'), 'mobile_number');
    expect(nameErr().hidden).toBe(true);
    expect($('o0i0-used').textContent).toBe('Bound to step 1 send_sms.to.');

    doc.querySelector('.opt-card[data-oi="0"] [data-act="in-add"]').click();
    await tick(window);
    setValue(window, $('o0i1-label'), 'Reminder day');
    setValue(window, $('o0i1-type'), 'enum', 'change');
    const card1 = () => doc.querySelector('.opt-card[data-oi="0"] .in-card[data-ij="1"]');
    card1().querySelector('[data-act="choice-add"]').click();
    await tick(window);
    card1().querySelector('[data-act="choice-add"]').click();
    await tick(window);
    setValue(window, $('o0i1c0'), 'monday');
    setValue(window, $('o0i1c1'), 'friday');
    expect([...$('o0i1-default').options].map((o) => o.value)).toEqual(['', 'monday', 'friday']);   // follows the typing
    setValue(window, $('o0i1-default'), 'friday', 'change');
    $('o0i1-req').checked = false;
    $('o0i1-req').dispatchEvent(new window.Event('change', { bubbles: true }));
    setValue(window, $('o0i1-bind'), '0|message', 'change');
    // the sample form mirrors the clicker's: a tel field and the enum's dropdown
    expect($('s0_0').getAttribute('type')).toBe('tel');
    expect([...$('s0_1').options].map((o) => o.textContent)).toEqual(['default: friday', 'monday', 'friday']);

    await dry(b);
    const [body] = posts(calls);
    expect(body).toEqual({
      name: 'Text a client', prompt: 'Send a reminder?', mode: 'once', dry_run: true,
      options: [{
        value: 'text_them', label: 'Text them',
        plan: [{ fn: 'send_sms', params: { from: '2485559999', to: '[[input:mobile_number]]', message: '[[input:reminder_day]]' } }],
        inputs: [
          { name: 'mobile_number', label: 'Cell', type: 'phone', required: true, maxlen: 16 },
          { name: 'reminder_day', label: 'Reminder day', type: 'enum', required: false, maxlen: 64, choices: ['monday', 'friday'], default: 'friday' },
        ],
      }],
    });
    const ok = doc.querySelector('#preview-region .ok-box').textContent.replace(/\s+/g, ' ');
    expect(ok).toContain('protection password (default — an option takes clicker inputs)');
    const block = doc.querySelector('#preview-region').textContent.replace(/\s+/g, ' ');
    expect(block).toContain('Cell mobile_number Phone number · required → step 1 send_sms.to');
    expect(block).toContain('Fill in Test values above');
    expect(errors).toEqual([]);
  });

  test('risk detection and the hard rule match validateMint over a config matrix (the pane\'s own body, the real service)', async () => {
    const { window } = await openBuilder(realHandler());
    const cases = [
      ['once + recipient', { mode: 'once' }, [PHONE, TEXT], [SMS]],
      ['repeatable + recipient', { mode: 'repeatable', max_uses: '3' }, [PHONE, TEXT], [SMS]],
      ['repeatable + content only', { mode: 'repeatable', max_uses: '3' }, [TEXT], [LOGM()]],
      ['html input', { mode: 'once' }, [HTML_IN], [LOGM()]],
      ['repeatable + recipient + html', { mode: 'repeatable', max_uses: '3' }, [PHONE, HTML_IN], [SMS]],
    ];
    for (const [name, top, inputs, steps] of cases) {
      await injectDraft(window, ONE(inputs, steps, top));
      const client = window.eval('detectedRisks(state.draft)');
      const needsCap = window.eval('needsMaxUses(state.draft)');
      const body = JSON.parse(window.eval('JSON.stringify(buildBody(true).body)'));
      let server = [];
      try {
        await ctaService.mintCta(makeCtaWorld(), { ...body, minted_by: SU_ID });
      } catch (e) {
        expect([name, e.code]).toEqual([name, 'risk_acceptance_required']);
        server = e.risks.map((r) => r.code);
      }
      expect([name, [...client].sort()]).toEqual([name, server.sort()]);
      // hard rule: the same link with every risk accepted and no max_uses
      const uncapped = { ...body, accept_risks: Object.keys(ctaService.CTA_RISKS), minted_by: SU_ID };
      delete uncapped.max_uses;
      let capRefused = false;
      try { await ctaService.mintCta(makeCtaWorld(), uncapped); } catch (e) { capRefused = /must set max_uses/.test(e.message); }
      expect([name, needsCap]).toEqual([name, capRefused]);
    }
  });

  test('repeatable + clicker-chosen recipient: max uses is a required field; the acknowledgment box gates the real mint', async () => {
    const b = await openBuilder(realHandler());
    const { window, doc, calls } = b;
    await injectDraft(window, ONE([PHONE, TEXT], [SMS], { mode: 'repeatable' }));
    expect(doc.getElementById('m-max-req').hidden).toBe(false);
    expect(doc.getElementById('m-max-hint').textContent).toMatch(/^Required/);
    const box = () => doc.querySelector('#risk-region [data-risk="open_recipient_repeatable"]');
    expect(box().checked).toBe(false);
    expect(doc.getElementById('risk-region').textContent).toContain('The clicker picks who gets the message');

    // blank cap: stopped in the pane, the reason under the field, nothing sent
    await dry(b);
    expect(posts(calls)).toHaveLength(0);
    expect(doc.querySelector('[data-ferr="max_uses"]').textContent).toMatch(/^Required/);
    setValue(window, doc.getElementById('m-max'), '5');
    expect(doc.querySelector('[data-ferr="max_uses"]')).toBeNull();

    // capped, not acknowledged: the server's 400
    await dry(b);
    expect(posts(calls)[0]).not.toHaveProperty('accept_risks');
    expect(doc.querySelector('#preview-region .inline-error').textContent.replace(/\s+/g, ' '))
      .toMatch(/Rejected:.*needs explicit risk acceptance.*Tick the acknowledgment/);

    // ticked: accepted, and the preview says it is recorded
    box().checked = true;
    box().dispatchEvent(new window.Event('change', { bubbles: true }));
    await dry(b);
    expect(posts(calls)[1]).toMatchObject({ max_uses: '5', accept_risks: ['open_recipient_repeatable'] });
    expect(doc.querySelector('#preview-region .ok-box').textContent).toMatch(/Acknowledged: The clicker picks who gets the message/);

    // single-use: the box goes, and the stale tick stays out of the body
    setValue(window, doc.getElementById('m-mode'), 'once', 'change');
    expect(box()).toBeNull();
    expect(doc.getElementById('m-max-req').hidden).toBe(true);
    await dry(b);
    expect(posts(calls)[2]).not.toHaveProperty('accept_risks');
    expect(doc.querySelector('#preview-region .ok-box')).not.toBeNull();
  });

  test('an HTML input asks for raw_html_input (real server); a code only the server knows still gets a box, in its words', async () => {
    let b = await openBuilder(realHandler());
    await injectDraft(b.window, ONE([HTML_IN], [{ fn: 'send_email', params: { from: 'info@4lsg.com', to: 'client@example.com', subject: 'Hi', html: '[[input:msg]]' } }]));
    const box = (doc, code) => doc.querySelector(`#risk-region [data-risk="${code}"]`);
    expect(b.doc.getElementById('risk-region').textContent).toContain('The clicker writes raw HTML');
    box(b.doc, 'raw_html_input').checked = true;
    box(b.doc, 'raw_html_input').dispatchEvent(new b.window.Event('change', { bubbles: true }));
    await dry(b);
    expect(posts(b.calls)[0].accept_risks).toEqual(['raw_html_input']);
    expect(b.doc.querySelector('#preview-region').textContent.replace(/\s+/g, ' '))
      .toContain('step 1 send_email.html — raw HTML, passed as typed');

    let n = 0;
    b = await openBuilder(realHandler((url, method) => {
      if (url === '/api/cta' && method === 'POST' && ++n === 1) {
        throw apiError(400, { status: 'error', code: 'risk_acceptance_required', message: 'cta: needs future_risk',
          risks: [{ code: 'future_risk', description: 'Something new the server wants acknowledged.' }] });
      }
      return undefined;
    }));
    await injectDraft(b.window, ONE([TEXT], [LOGM()]));
    expect(b.doc.getElementById('risk-region').textContent.trim()).toBe('');
    await dry(b);
    expect(b.doc.getElementById('risk-region').textContent).toContain('Something new the server wants acknowledged.');
    box(b.doc, 'future_risk').checked = true;
    box(b.doc, 'future_risk').dispatchEvent(new b.window.Event('change', { bubbles: true }));
    await dry(b);
    expect(posts(b.calls)[1].accept_risks).toEqual(['future_risk']);
  });

  test('the server\'s mint errors land under the field they name (real messages, every mapped shape)', async () => {
    const b = await openBuilder(realHandler());
    const { window, doc } = b;
    const T = (over) => ({ ...TEXT, ...over });
    const cases = [
      ['pattern the linear engine refuses', ONE([T({ pattern: '\\d{17}' })], [LOGM()]), 'options.0.inputs.0.pattern', /^Pattern must run in linear time/],
      ['max length over the cap', ONE([T({ maxlen: '2000' })], [LOGM()]), 'options.0.inputs.0.maxlen', /^Max length is required: an integer 1–1000/],
      ['fixed length below its floor → the Type field', ONE([T({ type: 'phone', maxlen: '11' })], [LOGM()]), 'options.0.inputs.0.type', /^Max length 11 is below 12/],
      ['bad name', ONE([T({ name: '1msg' })], [LOGM('1msg')]), 'options.0.inputs.0.name', /^Name must match/],
      ['duplicate name → the later input', ONE([T(), T({ label: 'Again' })], [LOGM()]), 'options.0.inputs.1.name', /also named "msg"/],
      ['declared, never bound', ONE([T(), T({ name: 'extra', label: 'Extra' })], [LOGM()]), 'bind:0.1', /^Not bound/],
      ['bad default', ONE([T({ type: 'phone', maxlen: '16', default: 'abc' })], [LOGM()]), 'options.0.inputs.0.default', /^Default: Enter a valid phone number\.$/],
      ['bad choice', ONE([T({ type: 'enum', maxlen: '64', choices: ['a b'] })], [LOGM()]), 'options.0.inputs.0.choices', /^Choices: each choice must match/],
      ['closed param', ONE([T()], [{ fn: 'lookup_contact', params: { contact_id: '[[input:msg]]' } }]), 'options.0.steps.0.params', /not open to clicker inputs/],
      ['recipient fed a text input', ONE([T()], [{ fn: 'send_sms', params: { from: '2485559999', to: '[[input:msg]]', message: 'hi' } }]), 'options.0.steps.0.params', /is a recipient — bind a phone or email input/],
      ['undeclared binding', ONE([T()], [{ fn: 'create_log', params: { type: 'note', message: '[[input:msg]]', subject: '[[input:zzz]]' } }]), 'options.0.steps.0.params', /no input "zzz" is declared/],
      ['unknown function', ONE([T()], [{ fn: 'nope_fn', params: {} }, LOGM()]), 'options.0.steps.0.fn', /unknown function "nope_fn"/],
      ['timeout option without a default', ONE([T()], [LOGM()], { timeout_option: 'go' }), 'options.0.inputs.0.default', /timeout option/],
      ['result template names no input', ONE([T()], [LOGM()], {}, { result_template: 'x [[input:nope]]' }), 'options.0.result_template', /^Result template references \[\[input:nope\]\]/],
    ];
    for (const [name, spec, anchor, re] of cases) {
      await injectDraft(window, spec);
      await dry(b);
      const errs = [...doc.querySelectorAll('#mint-region [data-ferr]')];
      expect([name, errs.map((e) => e.dataset.ferr)]).toEqual([name, [anchor]]);
      expect([name, errs[0].textContent]).toEqual([name, expect.stringMatching(re)]);
      // …and it sits with that field
      const fld = errs[0].closest('.fld');
      const field = anchor.startsWith('bind:') ? `[data-bind-input="${anchor.slice(5)}"]` : `[data-bind="${anchor}"], [data-bind^="${anchor}."]`;
      expect([name, !!fld.querySelector(field)]).toEqual([name, true]);
      expect([name, !!doc.querySelector('#preview-region [data-act="goto-err"]')]).toEqual([name, true]);
    }
    // editing the field clears it
    await injectDraft(window, cases[0][1]);
    await dry(b);
    expect(doc.querySelector('[data-ferr="options.0.inputs.0.pattern"]')).not.toBeNull();
    setValue(window, doc.getElementById('o0i0-pattern'), '\\d+');
    expect(doc.querySelector('[data-ferr]')).toBeNull();
  });

  test('test values: a second dry run with them as defaults; a refused value sits by its field; the mint body never carries them', async () => {
    const b = await openBuilder(realHandler());
    const { window, doc, calls } = b;
    await injectDraft(window, ONE(
      [{ ...PHONE, sample: 'abc' }, { ...TEXT, sample: 'Hello <there>' }], [SMS], {},
      { result_template: 'Sent: [[input:msg]] ([[1.output.id]])' },
    ));
    await dry(b);
    const [realBody, sampleBody] = posts(calls);
    const decl = [{ name: 'to', label: 'Phone', type: 'phone', required: true, maxlen: 16 }, { name: 'msg', label: 'Msg', type: 'text', required: true, maxlen: 100 }];
    expect(realBody.options[0].inputs).toEqual(decl);
    expect(sampleBody).toEqual({
      ...realBody,
      options: [{ ...realBody.options[0], inputs: [{ ...decl[0], default: 'abc' }, { ...decl[1], default: 'Hello <there>' }] }],
    });
    expect(doc.querySelector('[data-serr="0.0"]').textContent).toBe('Enter a valid phone number.');
    expect(doc.querySelector('[data-serr="0.1"]')).toBeNull();
    expect(doc.getElementById('preview-region').textContent).toContain('Test values refused');

    setValue(window, doc.getElementById('s0_0'), '(248) 555-0100');
    expect(doc.querySelector('[data-serr="0.0"]')).toBeNull();
    await dry(b);
    expect(posts(calls)).toHaveLength(4);
    expect(doc.getElementById('preview-region').textContent).toContain('Test values pass');
    const pres = [...doc.querySelectorAll('#preview-region pre.blk')].map((p) => p.textContent);
    expect(pres).toContain('Sent: Hello <there> (‹step 1 output.id›)');
    expect(doc.querySelector('#preview-region pre.blk there')).toBeNull();   // shown as text

    // a failing real dry run sends no test-values run
    setValue(window, doc.getElementById('m-prompt'), '');
    await dry(b);
    expect(posts(calls)).toHaveLength(5);
    // no test values → one request
    setValue(window, doc.getElementById('m-prompt'), 'Tell us');
    setValue(window, doc.getElementById('s0_0'), '');
    setValue(window, doc.getElementById('s0_1'), '');
    await dry(b);
    expect(posts(calls)).toHaveLength(6);
    expect(doc.getElementById('preview-region').textContent).toContain('Fill in Test values above');
  });

  test('a step refusing the test values is named under that option\'s test values', async () => {
    let n = 0;
    const b = await openBuilder(realHandler((url, method) => {
      if (url === '/api/cta' && method === 'POST' && ++n === 2) {
        throw apiError(400, { status: 'error', code: 'invalid', message: 'cta: options[0].plan[0] (send_sms) with default/sample inputs: message is too long' });
      }
      return undefined;
    }));
    await injectDraft(b.window, ONE([PHONE, { ...TEXT, sample: 'x' }], [SMS]));
    await dry(b);
    expect(b.doc.querySelector('[data-sstep="0"]').textContent).toBe("Step 1 (send_sms) won't take these values: message is too long");
    setValue(b.window, b.doc.getElementById('s0_1'), 'y');
    expect(b.doc.querySelector('[data-sstep="0"]')).toBeNull();
  });

  test('detail: each option lists its inputs; an expanded execution shows the submitted values labelled, as text', async () => {
    const opt = {
      value: 'text', label: 'Text',
      inputs: [
        { name: 'to', label: 'Mobile number', type: 'phone', required: true, maxlen: 16 },
        { name: 'msg', label: 'Message', type: 'text', required: false, maxlen: 300, default: 'Hi' },
      ],
      plan: [{ fn: 'send_sms', params: { from: '2485559999', to: '[[input:to]]', message: '[[input:msg]]' } }],
    };
    const cta = fullRow({ id: 7, mode: 'repeatable', max_uses: 5, options: [opt] });
    const ex = (over) => ({ cta_id: 7, option_value: 'text', status: 'success', responded_via: 'link', responder_user_id: null,
      responder_ip: '192.0.2.9', executed_at: new Date().toISOString(), plan_result: [{ fn: 'send_sms', ok: true, output: { id: 's1' }, ms: 1 }], ...over });
    const execs = [
      ex({ id: 3, inputs: { to: '+12485550100', msg: '<img src=x onerror=alert(1)>\nline 2' } }),
      ex({ id: 2, inputs: { to: '+12485550100' } }),
      ex({ id: 1, inputs: null }),
    ];
    const { window, doc } = await boot({
      handler: (url, method) => {
        if (url === '/api/cta' && method === 'GET') return { ctas: [row({ id: 7, mode: 'repeatable', max_uses: 5 })] };
        if (url === '/api/cta/7/executions') return { cta, executions: execs };
        throw new Error(`unexpected ${method} ${url}`);
      },
    });
    doc.querySelector('#list-region tr.row[data-id="7"]').click();
    await tick(window);
    const optText = doc.querySelector('#detail-region .opt-view').textContent.replace(/\s+/g, ' ');
    expect(optText).toContain('Mobile number to Phone number · required → step 1 send_sms.to');
    expect(optText).toContain('Message msg Text · optional · max 300 · default Hi → step 1 send_sms.message');

    for (const id of [3, 2, 1]) doc.querySelector(`#detail-region tr.row[data-exec="${id}"]`).click();
    await tick(window);
    const details = [...doc.querySelectorAll('#detail-region tr.exec-detail')];
    expect(details[0].textContent).toContain('Submitted inputs');
    expect(details[0].querySelector('img')).toBeNull();
    const vals = [...details[0].querySelectorAll('.in-val')].map((v) => [v.querySelector('.in-val-k').textContent.trim(), (v.querySelector('pre') || {}).textContent]);
    expect(vals).toEqual([['Mobile number to', '+12485550100'], ['Message msg', '<img src=x onerror=alert(1)>\nline 2']]);
    expect(details[1].textContent).toContain('(left blank)');
    expect(details[2].textContent).not.toContain('Submitted inputs');
  });

  test('Duplicate carries the declarations and bindings (the real server takes the copy); acknowledgments are re-asked, not carried', async () => {
    const SRC = fullRow({
      id: 8, name: 'Open text', mode: 'repeatable', max_uses: 4, protection: 'password', status: 'disabled',
      options: [{
        value: 'text', label: 'Text',
        inputs: [
          { name: 'to', label: 'Phone', type: 'phone', required: true, maxlen: 16 },
          { name: 'msg', label: 'Msg', type: 'text', required: false, maxlen: 100, default: 'Hello', pattern: '[^<>]+' },
        ],
        plan: [SMS],
      }],
    });
    const b = await boot({
      handler: realHandler((url, method) => {
        if (url === '/api/cta' && method === 'GET') return { ctas: [row({ id: 8, status: 'disabled', mode: 'repeatable' })] };
        if (url === '/api/cta/8/executions') return { cta: SRC, executions: [] };
        return undefined;
      }),
    });
    const { window, doc, calls } = b;
    doc.querySelector('#list-region tr.row[data-id="8"] [data-act="duplicate"]').click();
    await tick(window, 60);
    expect(doc.getElementById('o0i0-name').value).toBe('to');
    expect(doc.getElementById('o0i1-pattern').value).toBe('[^<>]+');
    expect(doc.querySelector('#mint-region .info-box').textContent).toContain('risk acknowledgments');
    const box = doc.querySelector('#risk-region [data-risk="open_recipient_repeatable"]');
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    await dry(b);
    const body = posts(calls)[0];
    expect(body.options[0].inputs).toEqual(SRC.options[0].inputs);
    expect(body.options[0].plan).toEqual(SRC.options[0].plan);
    expect(body).toMatchObject({ mode: 'repeatable', max_uses: '4', protection: 'password', accept_risks: ['open_recipient_repeatable'] });
    expect(doc.querySelector('#preview-region .ok-box')).not.toBeNull();
  });

  test('Extend / limits: "No cap" is locked on a link whose clicker picks the recipient (the function list is fetched for it)', async () => {
    const mk = (id, plan, inputs) => fullRow({ id, mode: 'repeatable', max_uses: 4, options: [{ value: 'go', label: 'Go', inputs, plan }] });
    const links = { 1: mk(1, [SMS], [{ name: 'to', label: 'P', type: 'phone', required: true, maxlen: 16 }, { name: 'msg', label: 'M', type: 'text', required: true, maxlen: 10 }]),
      2: mk(2, [LOGM()], [{ name: 'msg', label: 'M', type: 'text', required: true, maxlen: 10 }]) };
    const { window, doc } = await boot({
      handler: realHandler((url, method) => {
        if (url === '/api/cta' && method === 'GET') return { ctas: [row({ id: 1, mode: 'repeatable', max_uses: 4 }), row({ id: 2, mode: 'repeatable', max_uses: 4 })] };
        const m = /^\/api\/cta\/(\d+)\/executions$/.exec(url);
        if (m) return { cta: links[m[1]], executions: [] };
        return undefined;
      }),
    });
    for (const [id, locked] of [[1, true], [2, false]]) {
      doc.querySelector('[data-nav="list"]').click();
      await tick(window);
      doc.querySelector(`#list-region tr.row[data-id="${id}"]`).click();
      await tick(window);
      doc.querySelector('#detail-region [data-act="edit"]').click();
      await tick(window);
      expect([id, doc.getElementById('p-nocap').disabled]).toEqual([id, locked]);
      expect([id, doc.getElementById('p-cap-lock').hidden]).toEqual([id, !locked]);
      doc.getElementById('patch-cancel').click();
    }
    // with the list already loaded, the lock is there on the first paint
    doc.querySelector('[data-nav="list"]').click();
    await tick(window);
    doc.querySelector('#list-region tr.row[data-id="1"]').click();
    await tick(window);
    doc.querySelector('#detail-region [data-act="edit"]').click();
    expect(doc.getElementById('p-nocap').disabled).toBe(true);
  });
});
