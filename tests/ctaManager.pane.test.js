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
 *
 * In jsdom a top-level window is its own parent, so window.apiSend IS the
 * pane's P.apiSend (the pane never assigns window.apiSend — no relay loop).
 */

'use strict';

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

  test('cancelled offers no mutating action; disabled offers re-enable, extend and cancel', async () => {
    let { doc } = await openDetail(fullRow({ id: 1, status: 'cancelled' }), []);
    let acts = [...doc.querySelectorAll('#detail-region .btn-row [data-act]')].map((b) => b.dataset.act);
    expect(acts).toEqual(['copy']);
    ({ doc } = await openDetail(fullRow({ id: 1, status: 'disabled' }), []));
    acts = [...doc.querySelectorAll('#detail-region .btn-row [data-act]')].map((b) => b.dataset.act);
    expect(acts).toEqual(['copy', 'edit', 'reenable', 'cancel']);
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
