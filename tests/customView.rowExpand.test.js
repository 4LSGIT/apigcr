/**
 * @jest-environment node
 *
 * tests/customView.rowExpand.test.js — the YisraView row expand (2026-10-06).
 *
 * BOOTS public/customView.html for real, in jsdom, against a stub shell, and
 * drives it with real mouse events. Nothing in the page is stubbed: the click
 * handler, the row-key logic, the footer switch (rendered by the real
 * /js/ycPager.js) and the post-save refresh all run as shipped.
 *
 * THE PARENT SHIM. customView runs as an iframe child and relays the shell's
 * apiSend down to its open_form modal with
 *     window.apiSend = (…) => P.apiSend(…)      // P = window.parent
 * In jsdom a top-level window IS its own parent, so a plain stub on `window`
 * would be overwritten by that relay and the relay would call itself forever.
 * The stub is therefore an ACCESSOR whose setter ignores writes — which is
 * exactly the real topology: the child's assignment lands on the child window
 * and never touches the parent's apiSend.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/customView.html'), 'utf8');
const CHARTS  = fs.readFileSync(path.join(ROOT, 'public/js/reportCharts.js'), 'utf8');
const PAGER   = fs.readFileSync(path.join(ROOT, 'public/js/ycPager.js'), 'utf8');

const DOMS = [];
afterEach(() => {
  DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) { /* noop */ } });
});

const tick = (w, ms = 20) => new Promise(r => w.setTimeout(r, ms));

const LONG_NOTE = 'Client called about the garnishment — employer has not stopped it.\n' +
                  'Sent the stay letter to payroll 10/2.\nFollow up Friday.';

const VIEW = {
  id: 13,
  report_key: 'bk_worksheet',
  title: 'Bankruptcy Worksheet',
  description: '',
  sql_text: 'SELECT 1',
  params: [],
  caveats: [],
  columns_meta: [
    { key: 'edit', label: '✎', width: 44, align: 'center',
      action: { type: 'open_form', idKey: 'case_id', formKey: 'bk_worksheet', linkType: 'case' } },
    { key: 'case_id', label: 'Case', action: { type: 'open_case', idKey: 'case_id' } },
    { key: 'debtor', label: 'Debtor', action: { type: 'open_contact', idKey: 'contact_id' } },
    { key: 'contact_id', hidden: true },
    { key: 'notes', label: 'Notes', width: 260 },
    { key: 'email', label: 'Email', action: { type: 'copy' } },
  ],
};

function rowsV1() {
  return [
    { edit: '✎', case_id: 'AAAA1111', debtor: 'Ann Applebaum', contact_id: 1,
      notes: LONG_NOTE, email: 'ann@example.com' },
    { edit: '✎', case_id: 'BBBB2222', debtor: 'Bob Baker', contact_id: 2,
      notes: '', email: 'bob@example.com' },
    { edit: '✎', case_id: 'CCCC3333', debtor: 'Cy Cole', contact_id: 3,
      notes: '⚠ Do not call before 10am\nPrefers text', email: 'cy@example.com' },
  ];
}

const FIELDS = ['edit', 'case_id', 'debtor', 'contact_id', 'notes', 'email']
  .map(name => ({ name, type: name === 'contact_id' ? 3 : 253 }));

/**
 * @param {object}   [o]
 * @param {object[][]} [o.runs]       successive run payload row sets; the last repeats
 * @param {string|null} [o.storage]   pre-seeded yc.customView.expand value
 */
async function boot({ runs = [rowsV1()], storage = null } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://app.4lsg.com/customView.html?key=bk_worksheet',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  DOMS.push(dom);
  const { window } = dom;
  if (storage !== null) window.localStorage.setItem('yc.customView.expand', storage);

  const calls = [];
  let runIx = 0;
  const apiSend = async (url, method, body) => {
    calls.push({ url, method, body });
    if (url === '/api/reports?kind=view') return { reports: [{ id: 13, report_key: 'bk_worksheet', title: VIEW.title }] };
    if (url === '/api/reports/13' && method === 'GET') return { report: JSON.parse(JSON.stringify(VIEW)) };
    if (url === '/api/reports/13/run') {
      const rows = runs[Math.min(runIx++, runs.length - 1)];
      return { rows: JSON.parse(JSON.stringify(rows)), fields: FIELDS, rowCount: rows.length, durationMs: 1 };
    }
    throw new Error('unexpected ' + method + ' ' + url);
  };
  // See THE PARENT SHIM in the header.
  Object.defineProperty(window, 'apiSend', { configurable: true, get: () => apiSend, set: () => {} });
  window.addFile = () => {};

  window.eval(CHARTS);
  window.eval(PAGER);

  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const styles = [...noComments.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]);
  const st = window.document.createElement('style');
  st.textContent = styles.join('\n');
  window.document.head.appendChild(st);
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');

  const inline = [...noComments.matchAll(
    /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // fence: a second inline block means this harness is stale.
  expect(inline.length).toBe(1);

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  window.eval(inline[0]);

  await tick(window, 60);
  return { window, calls, errors, doc: window.document };
}

/** A real click: mousedown then click, at (x, y). */
function clickAt(window, el, x = 10, y = 10) {
  el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

const trOf = (doc, caseId) =>
  [...doc.querySelectorAll('#tbody tr')].find(tr => tr.textContent.includes(caseId));
const notesTd = (doc, caseId) => {
  const tr = trOf(doc, caseId);
  const ix = [...doc.querySelectorAll('#thead th')].findIndex(th => th.textContent.startsWith('Notes'));
  return tr.children[ix];
};
const state = tr => tr.classList.contains('is-expanded') ? 'open'
  : tr.classList.contains('is-collapsed') ? 'closed' : 'default';

describe('customView row expand', () => {
  test('boots clean and renders every row collapsed by default', async () => {
    const { doc, errors } = await boot();
    expect(errors).toEqual([]);
    expect(doc.querySelectorAll('#tbody tr')).toHaveLength(3);
    expect(doc.getElementById('vTable').classList.contains('rows-expanded')).toBe(false);
    for (const tr of doc.querySelectorAll('#tbody tr')) expect(state(tr)).toBe('default');
  });

  test('the old >60-char auto-wrap is gone', async () => {
    const { doc } = await boot();
    expect(LONG_NOTE.length).toBeGreaterThan(60);
    expect(doc.querySelectorAll('#tbody td.wrap')).toHaveLength(0);
  });

  test('action and copy cells carry no whitespace text nodes (pre-wrap would show them)', async () => {
    const { doc } = await boot();
    const tr = trOf(doc, 'AAAA1111');
    const tds = [...tr.children];
    for (const td of tds) {
      for (const n of td.childNodes) {
        if (n.nodeType === 3) expect(n.textContent).not.toMatch(/^\s+$/);
      }
    }
    // the ✎ cell starts with its link; the copy cell is text then button
    expect(tds[0].firstChild.tagName).toBe('A');
    const email = tds.find(td => td.querySelector('.copybtn'));
    expect(email.childNodes[0].textContent).toBe('ann@example.com');
    expect(email.childNodes[1].tagName).toBe('BUTTON');
  });

  test('clicking a row opens it; clicking again closes it', async () => {
    const { window, doc } = await boot();
    clickAt(window, notesTd(doc, 'AAAA1111'));
    expect(state(trOf(doc, 'AAAA1111'))).toBe('open');
    expect(state(trOf(doc, 'BBBB2222'))).toBe('default');   // only that row
    clickAt(window, notesTd(doc, 'AAAA1111'));
    expect(state(trOf(doc, 'AAAA1111'))).toBe('default');
  });

  test('an opened row renders its cells pre-wrap, so line breaks show', async () => {
    const { window, doc } = await boot();
    const td = notesTd(doc, 'AAAA1111');
    expect(window.getComputedStyle(td).whiteSpace).toBe('nowrap');
    clickAt(window, td);
    expect(window.getComputedStyle(notesTd(doc, 'AAAA1111')).whiteSpace).toBe('pre-wrap');
    expect(notesTd(doc, 'AAAA1111').textContent).toBe(LONG_NOTE);   // newlines intact in the DOM
  });

  test('the ✎ link opens the form and does NOT toggle the row', async () => {
    const { window, doc } = await boot();
    const link = trOf(doc, 'AAAA1111').querySelector('a[data-act="open_form"]');
    clickAt(window, link);
    expect(state(trOf(doc, 'AAAA1111'))).toBe('default');
    expect(doc.getElementById('formModal').classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('fmFrame').getAttribute('src'))
      .toBe('/forms/render.html?form_key=bk_worksheet&case_id=AAAA1111');
  });

  test('the copy button does NOT toggle the row', async () => {
    const { window, doc } = await boot();
    // jsdom has no clipboard; the page falls back to execCommand inside a try
    window.document.execCommand = () => true;
    clickAt(window, trOf(doc, 'AAAA1111').querySelector('.copybtn'));
    expect(state(trOf(doc, 'AAAA1111'))).toBe('default');
  });

  test('a drag (text selection) does not toggle', async () => {
    const { window, doc } = await boot();
    const td = notesTd(doc, 'AAAA1111');
    td.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));
    td.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 80, clientY: 10 }));
    expect(state(trOf(doc, 'AAAA1111'))).toBe('default');
  });

  test('Expand rows switch opens every row, persists per view, and resets overrides', async () => {
    const { window, doc } = await boot();
    clickAt(window, notesTd(doc, 'AAAA1111'));               // a hand-opened row
    expect(state(trOf(doc, 'AAAA1111'))).toBe('open');

    const cb = doc.querySelector('#pgFoot .yc-pager-expand input[type=checkbox]');
    expect(cb).not.toBeNull();
    expect(cb.checked).toBe(false);
    cb.checked = true;
    cb.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(doc.getElementById('vTable').classList.contains('rows-expanded')).toBe(true);
    for (const tr of doc.querySelectorAll('#tbody tr')) expect(state(tr)).toBe('default'); // override dropped
    expect(JSON.parse(window.localStorage.getItem('yc.customView.expand'))).toEqual({ bk_worksheet: true });
    // …dropped from STATE too, not just from the DOM: a re-render (sort) must
    // not resurrect the hand-opened row's override.
    [...doc.querySelectorAll('#thead th')].find(th => th.textContent.startsWith('Debtor')).click();
    for (const tr of doc.querySelectorAll('#tbody tr')) expect(state(tr)).toBe('default');

    // with the switch on, a click CLOSES just that row, and a second click hands it back
    clickAt(window, notesTd(doc, 'CCCC3333'));
    expect(state(trOf(doc, 'CCCC3333'))).toBe('closed');
    expect(window.getComputedStyle(notesTd(doc, 'CCCC3333')).whiteSpace).toBe('nowrap');
    clickAt(window, notesTd(doc, 'CCCC3333'));
    expect(state(trOf(doc, 'CCCC3333'))).toBe('default');

    // switching off clears the stored flag
    const cb2 = doc.querySelector('#pgFoot .yc-pager-expand input[type=checkbox]');
    cb2.checked = false;
    cb2.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(doc.getElementById('vTable').classList.contains('rows-expanded')).toBe(false);
    expect(JSON.parse(window.localStorage.getItem('yc.customView.expand'))).toEqual({});
  });

  test('a stored switch is honoured on open', async () => {
    const { doc } = await boot({ storage: JSON.stringify({ bk_worksheet: true }) });
    expect(doc.getElementById('vTable').classList.contains('rows-expanded')).toBe(true);
    expect(doc.querySelector('#pgFoot .yc-pager-expand input').checked).toBe(true);
  });

  test('garbage in storage degrades to off, never throws', async () => {
    const { doc, errors } = await boot({ storage: '{not json' });
    expect(errors).toEqual([]);
    expect(doc.getElementById('vTable').classList.contains('rows-expanded')).toBe(false);
  });

  test('an opened row stays open through a sort', async () => {
    const { window, doc } = await boot();
    clickAt(window, notesTd(doc, 'AAAA1111'));
    const debtorTh = [...doc.querySelectorAll('#thead th')].find(th => th.textContent.startsWith('Debtor'));
    debtorTh.click(); debtorTh.click();                       // descending: Ann moves to the bottom
    const trs = [...doc.querySelectorAll('#tbody tr')];
    expect(trs[trs.length - 1].textContent).toContain('AAAA1111');
    expect(state(trOf(doc, 'AAAA1111'))).toBe('open');
    expect(trs.filter(tr => state(tr) === 'open')).toHaveLength(1);
  });

  test('an opened row stays open through the post-save refresh, even though its notes changed', async () => {
    const v2 = rowsV1();
    v2[0].notes = LONG_NOTE + '\nUpdated from the modal.';
    const { window, doc, calls } = await boot({ runs: [rowsV1(), v2] });
    clickAt(window, notesTd(doc, 'AAAA1111'));
    clickAt(window, trOf(doc, 'AAAA1111').querySelector('a[data-act="open_form"]'));
    const frame = doc.getElementById('fmFrame');
    window.dispatchEvent(new window.MessageEvent('message', {
      data: { type: 'form-saved' }, source: frame.contentWindow,
    }));
    await tick(window, 30);
    expect(calls.filter(c => c.url === '/api/reports/13/run')).toHaveLength(2);
    expect(notesTd(doc, 'AAAA1111').textContent).toContain('Updated from the modal.');
    expect(state(trOf(doc, 'AAAA1111'))).toBe('open');
  });

  test('negative control: a row with no id column still toggles (content-keyed)', async () => {
    // Re-boot with a definition that has no actions at all.
    const saved = VIEW.columns_meta;
    VIEW.columns_meta = [{ key: 'debtor', label: 'Debtor' }, { key: 'notes', label: 'Notes' }];
    try {
      const { window, doc } = await boot({
        runs: [[{ debtor: 'Ann', notes: LONG_NOTE }, { debtor: 'Bob', notes: 'x' }]],
      });
      const tr = doc.querySelectorAll('#tbody tr')[0];
      clickAt(window, tr.children[1]);
      expect(state(doc.querySelectorAll('#tbody tr')[0])).toBe('open');
      expect(state(doc.querySelectorAll('#tbody tr')[1])).toBe('default');
    } finally {
      VIEW.columns_meta = saved;
    }
  });
});
