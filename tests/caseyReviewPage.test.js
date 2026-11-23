// Casey v2 S4b — public/caseyReview.html (Admin → Casey Chats, SU) in JSDOM with
// a FAKE parent: the role gate (su in, others out), boot (the list, the user
// menu built from it, the status), the filters → the query (user, q, flagged),
// a click → the transcript iframe at /casey.html?review=<id>, the apiSend
// passthrough the pane relies on, the Support Inbox deep link (c<chat>~s<seq>)
// through a fake ycSubTab. No network.
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'caseyReview.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*)<\/script>/.exec(HTML)[1];
const ANCHOR = 'const P = window.parent;';
if (SCRIPT.split(ANCHOR).length !== 2) throw new Error('caseyReview.html: the parent anchor moved');
const PATCHED = SCRIPT.replace(ANCHOR, 'const P = window.__parent;');
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const CHATS = [
  { id: 23, user_id: 7, user_name: 'Rena', title: 'Mail to Mary', model: 'claude-opus-5-5', updated_at: '2026-11-23T11:00:00.000Z', message_count: 6, cost_cents: 9, flags: 2 },
  { id: 22, user_id: 6, user_name: 'IT', title: 'Overdue <b>tasks</b>', model: 'claude-sonnet-5-5', updated_at: '2026-11-23T10:00:00.000Z', message_count: 2, cost_cents: 0.5, flags: 0 },
];
async function page({ roles = 'su', chats = CHATS, held = null } = {}) {
  const dom = new JSDOM(HTML.replace('<script src="/themeSync.js"></script>', '').replace('<script src="/js/ycSubTab.js"></script>', '').replace('<script src="/js/diag.js"></script>', ''), { runScripts: 'outside-only', url: 'https://app.test/caseyReview.html', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  const reported = [];
  w.ycSubTab = { leaf: { take: () => held, report: (r) => reported.push(r) }, parse: (r) => (r ? String(r).split('~') : null) };
  w.__parent = {
    firmData: { currentUser: { user: 6, username: 'IT', roles } },
    apiSend: async (p, method = 'GET', body, headers, opts) => {
      calls.push({ p, method, body, headers, opts });
      if (p.startsWith('/api/casey/review?')) { const u = new URL(p, 'https://x'); let rows = chats; if (u.searchParams.get('user')) rows = rows.filter((c) => String(c.user_id) === u.searchParams.get('user')); if (u.searchParams.get('flagged') === '1') rows = rows.filter((c) => c.flags); return { status: 'success', chats: rows }; }
      throw new Error('unexpected ' + method + ' ' + p);
    },
  };
  w.eval(PATCHED);
  await settle(10);
  return { w, d: w.document, E: (id) => w.document.getElementById(id), calls, reported, settle };
}

test('the gate: su sees the page; another role does not; no parent → not authenticated', async () => {
  const p = await page();
  expect(p.E('main').hidden).toBe(false);
  const no = await page({ roles: 'admin,it' });
  expect(no.d.body.textContent).toMatch(/for superusers/);
  expect(no.calls).toHaveLength(0);
});

test('boot: the list (titles escaped, user, time, counts, cost, the flag mark), the user menu from the list, the status; the passthrough apiSend exists for the pane', async () => {
  const p = await page();
  expect(p.calls[0].p).toBe('/api/casey/review?limit=100');
  const rows = [...p.E('rows').querySelectorAll('tr.row')];
  expect(rows.map((r) => r.dataset.id)).toEqual(['23', '22']);
  expect(rows[1].querySelector('td.t').textContent).toBe('Overdue <b>tasks</b>');
  expect(rows[1].querySelector('td.t b')).toBeNull();
  expect(rows[0].querySelector('.flag').textContent.trim()).toBe('2');
  expect(rows[1].querySelector('.flag')).toBeNull();
  expect([...rows[0].querySelectorAll('td')].map((td) => td.textContent.trim()).slice(3, 5)).toEqual(['6', '9.0¢']);
  expect([...p.E('fUser').options].map((o) => [o.value, o.textContent])).toEqual([['', 'Every user'], ['6', 'IT'], ['7', 'Rena']]);
  expect(p.E('status').textContent).toBe('2 chat(s)');
  expect(typeof p.w.openChatReview).toBe('function');
  expect(p.w.open).not.toBe(p.w.openChatReview);   // window.open is not clobbered
  const many = await page({ chats: Array.from({ length: 100 }, (_, i) => ({ ...CHATS[0], id: 1000 + i })) });
  expect(many.E('status').textContent).toMatch(/latest 100 chats/);
  expect(typeof p.w.apiSend).toBe('function');
  await p.w.apiSend('/api/casey/review?limit=100');
  expect(p.calls[p.calls.length - 1].p).toBe('/api/casey/review?limit=100');   // the pane's calls reach the shell through this page
});

test('filters: the user menu, flagged only and the title search ride the query; Refresh reloads', async () => {
  const p = await page();
  p.E('fUser').value = '7'; p.E('fUser').dispatchEvent(new p.w.Event('change'));
  await p.settle(6);
  expect(p.calls[p.calls.length - 1].p).toBe('/api/casey/review?user=7&limit=100');
  expect([...p.E('rows').querySelectorAll('tr.row')].map((r) => r.dataset.id)).toEqual(['23']);
  expect(p.E('fUser').value).toBe('7');   // a filtered load keeps the menu
  p.E('fUser').value = ''; p.E('fFlagged').checked = true; p.E('fFlagged').dispatchEvent(new p.w.Event('change'));
  await p.settle(6);
  expect(p.calls[p.calls.length - 1].p).toBe('/api/casey/review?flagged=1&limit=100');
  p.E('fQ').value = 'Mary 100%'; p.E('fQ').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter' }));
  await p.settle(6);
  expect(p.calls[p.calls.length - 1].p).toBe('/api/casey/review?q=Mary+100%25&flagged=1&limit=100');
  const n = p.calls.length;
  p.E('refresh').click();
  await p.settle(6);
  expect(p.calls.length).toBe(n + 1);
});

test('a click opens the transcript iframe at /casey.html?review=<id>; the row is marked; the Support Inbox deep link c<chat>~s<seq> opens it with the seq and clears the rest', async () => {
  const p = await page();
  p.E('rows').querySelector('tr.row[data-id="22"]').click();
  const fr = p.E('view').querySelector('iframe');
  expect(fr.getAttribute('src')).toBe('/casey.html?review=22');
  expect(fr.title).toBe('Casey chat 22');
  expect(p.E('rows').querySelector('tr.row[data-id="22"]').classList.contains('cur')).toBe(true);
  const deep = await page({ held: 'c23~s5' });
  expect(deep.E('view').querySelector('iframe').getAttribute('src')).toBe('/casey.html?review=23&seq=5');
  expect(deep.reported).toEqual(['']);
  const bad = await page({ held: 'r41' });
  expect(bad.E('view').querySelector('iframe')).toBeNull();
});
