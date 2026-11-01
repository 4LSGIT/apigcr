// tests/toolManagerVisibility.test.js
//
/**
 * launcher-nits L5 — the Tool Manager's "Who sees it in the tool picker"
 * control (public/toolManager.html). Boots the real page in jsdom over a
 * recording apiSend: the form reads and writes visible_to, the list marks a
 * restricted tool, and the page's copy of the roles stays pinned to
 * lib/capabilities.js. The server side: tests/apiTools.routes.test.js and
 * tests/launcherL5.pickers.mysql.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { ROLE_MEMBERS } = require('../lib/capabilities');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'toolManager.html'), 'utf8');
const DOMS = [];
afterEach(() => { while (DOMS.length) DOMS.pop().window.close(); });
const tick = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const ROW = { id: 1, tool_key: 'carve', title: 'Carve', status: 'live', version_count: 2, updated_by: 'IT', updated_at: '2026-10-28T17:23:30Z', visible_to: null };

async function boot(rows = [ROW]) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://app.4lsg.com/toolManager.html', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  DOMS.push(dom);
  const { window } = dom;
  const calls = [];
  // The page's window.parent is the shell; here it is this object.
  window.__shell = {
    apiSend: async (url, method = 'GET', payload = null) => {
      calls.push({ url, method, payload: payload == null ? null : JSON.parse(JSON.stringify(payload)) });
      if (url === '/api/tools' && method === 'GET') return { tools: rows };
      const one = /^\/api\/tools\/(\d+)$/.exec(url);
      if (one && method === 'GET') return { tool: { html: '<p>x</p>', ...rows.find((r) => r.id === Number(one[1])) } };
      return { tool: {} };
    },
  };
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  window.document.body.innerHTML = (/<body[^>]*>([\s\S]*)<\/body>/.exec(noComments) || [])[1].replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(inline).toHaveLength(1);       // fence: a second block means this harness is stale
  const SEAM = 'const P = window.parent;';
  expect(inline[0].split(SEAM)).toHaveLength(2);
  const sc = window.document.createElement('script');
  sc.textContent = inline[0].replace(SEAM, 'const P = window.__shell;');
  window.document.body.appendChild(sc);
  await tick();
  return { window, doc: window.document, calls, E: (id) => window.document.getElementById(id) };
}

const ticked = (t) => [...t.E('f-vis-roles').querySelectorAll('input[data-role]:checked')].map((c) => c.dataset.role);
const click = (t, el) => { el.click(); return tick(); };
const openRow = (t) => click(t, t.doc.querySelector('tr[data-id] button[data-action=edit]'));
const saved = (t) => t.calls.filter((c) => c.method === 'PATCH' || c.method === 'POST').pop();

describe('the role list', () => {
  test('every role but su is on the page, ticked or locked; the page pins the copy', async () => {
    const t = await boot();
    const src = /const ROLE_LOCKED = (\[.*?\]);\nconst ROLE_TICKS = (\[.*?\]);/.exec(HTML);
    const both = [...JSON.parse(src[1].replace(/'/g, '"')), ...JSON.parse(src[2].replace(/'/g, '"'))];
    expect([...both].sort()).toEqual(ROLE_MEMBERS.filter((r) => r !== 'su').sort());
    expect(t.E('f-vis-roles').querySelectorAll('input[data-role]')).toHaveLength(4);
  });

  test('SU, Admin and IT are ticked and locked, and say why', async () => {
    const t = await boot();
    const locked = [...t.E('f-vis-roles').querySelectorAll('label.locked')];
    expect(locked.map((l) => l.textContent.trim())).toEqual(['SU', 'Admin', 'IT']);
    for (const l of locked) {
      expect(l.querySelector('input').checked).toBe(true);
      expect(l.querySelector('input').disabled).toBe(true);
      expect(l.title).toMatch(/always see every tool/);
    }
  });

  test('the form says this is visibility only', () => {
    const hint = /id="f-vis"[\s\S]*?<div class="hint">([\s\S]*?)<\/div>/.exec(HTML)[1].replace(/\s+/g, ' ');
    expect(hint).toMatch(/a button someone already made keeps working/);
    expect(hint).toMatch(/stays reachable/);
  });
});

describe('the form', () => {
  test('a tool for everyone opens on Everyone with the roles out of sight; a new tool too', async () => {
    const t = await boot();
    await openRow(t);
    expect([t.E('f-vis-all').checked, t.E('f-vis-some').checked, t.E('f-vis-roles').hidden]).toEqual([true, false, true]);
    await click(t, t.E('f-cancel'));
    await click(t, t.E('new-btn'));
    expect([t.E('f-vis-all').checked, t.E('f-vis-roles').hidden]).toEqual([true, true]);
  });

  test('a restricted tool opens on Hidden, except with its roles ticked; [] ticks none', async () => {
    const t = await boot([{ ...ROW, visible_to: ['staff', 'attorney'] }, { ...ROW, id: 2, tool_key: 'b', visible_to: [] }]);
    await openRow(t);
    expect([t.E('f-vis-some').checked, t.E('f-vis-roles').hidden]).toEqual([true, false]);
    expect(ticked(t)).toEqual(['attorney', 'staff']);
    await click(t, t.E('f-cancel'));
    await click(t, t.doc.querySelectorAll('tr[data-id] button[data-action=edit]')[1]);
    expect(t.E('f-vis-some').checked).toBe(true);
    expect(ticked(t)).toEqual([]);
  });

  test('a form never carries the previous tool\'s ticks', async () => {
    const t = await boot([{ ...ROW, visible_to: ['staff'] }, { ...ROW, id: 2, tool_key: 'b', visible_to: null }]);
    await openRow(t);
    await click(t, t.E('f-cancel'));
    await click(t, t.doc.querySelectorAll('tr[data-id] button[data-action=edit]')[1]);
    await click(t, t.E('f-vis-some'));
    expect(ticked(t)).toEqual([]);
  });

  test('choosing Hidden, except shows the roles; Everyone hides them again', async () => {
    const t = await boot();
    await openRow(t);
    await click(t, t.E('f-vis-some'));
    expect(t.E('f-vis-roles').hidden).toBe(false);
    await click(t, t.E('f-vis-all'));
    expect(t.E('f-vis-roles').hidden).toBe(true);
  });

  test('Save sends the ticked roles, never a locked one', async () => {
    const t = await boot();
    await openRow(t);
    await click(t, t.E('f-vis-some'));
    await click(t, t.E('f-vis-roles').querySelector('input[data-role=staff]'));
    await click(t, t.E('f-save'));
    expect(saved(t)).toMatchObject({ url: '/api/tools/1', method: 'PATCH', payload: { visible_to: ['staff'] } });
  });

  test('Hidden, except with nothing ticked saves [], not everyone', async () => {
    const t = await boot();
    await openRow(t);
    await click(t, t.E('f-vis-some'));
    await click(t, t.E('f-save'));
    expect(saved(t).payload.visible_to).toEqual([]);
  });

  test('Everyone saves null, whatever was ticked', async () => {
    const t = await boot([{ ...ROW, visible_to: ['staff'] }]);
    await openRow(t);
    await click(t, t.E('f-vis-all'));
    await click(t, t.E('f-save'));
    expect(saved(t).payload.visible_to).toBeNull();
  });

  test('a new tool sends its choice on create', async () => {
    const t = await boot();
    await click(t, t.E('new-btn'));
    t.E('f-key').value = 'new-tool';
    t.E('f-html').value = '<p>n</p>';
    await click(t, t.E('f-save'));
    expect(saved(t)).toMatchObject({ url: '/api/tools', method: 'POST', payload: { tool_key: 'new-tool', visible_to: null } });
  });
});

describe('the list', () => {
  const badge = (t) => t.doc.querySelector('tr[data-id] td:nth-child(3)');

  test('a tool for everyone has no mark', async () => {
    const t = await boot();
    expect(badge(t).textContent.trim()).toBe('Live');
  });

  test('a restricted tool is marked, and the mark says who', async () => {
    const t = await boot([{ ...ROW, visible_to: ['staff', 'attorney'] }]);
    const mark = badge(t).querySelectorAll('.badge')[1];
    expect(mark.textContent).toBe('Restricted');
    expect(mark.title).toBe('In the tool picker for: Staff, Attorney, and SU, Admin and IT');
  });

  test('[] reads as firm admins only, and a stored locked role is not named twice', async () => {
    const t = await boot([{ ...ROW, visible_to: [] }, { ...ROW, id: 2, tool_key: 'b', visible_to: ['admin'] }]);
    const marks = [...t.doc.querySelectorAll('tr[data-id] td:nth-child(3) .badge:nth-child(2)')].map((m) => m.title);
    expect(marks).toEqual(['In the tool picker for: SU, Admin and IT only', 'In the tool picker for: SU, Admin and IT only']);
  });
});
