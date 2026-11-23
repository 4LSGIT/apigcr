// Casey v2 S4a — public/caseyNotes.html (Admin → Casey Notes) in JSDOM with a
// FAKE parent (the Admin-pane pattern: `const P = window.parent` pointed at the
// fake by one anchored substitution). Covers: the cosmetic role gate (it / su
// in, others out), boot (scopes, the picker with the families and the • mark,
// the current body, the versions table), the character count against the
// scope's cap and the Save button's state (dirty + note + under cap), Save →
// PUT with the scope / body / edit_note and the reload, a refused save shown,
// Discard, a scope change, View → the viewer, Restore → POST. No network.
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'caseyNotes.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*)<\/script>/.exec(HTML)[1];
const ANCHOR = 'const P = window.parent;';
if (SCRIPT.split(ANCHOR).length !== 2) throw new Error('caseyNotes.html: the parent anchor moved');
const PATCHED = SCRIPT.replace(ANCHOR, 'const P = window.__parent;');

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(); };

function store(init) {
  const rows = init.map((r) => ({ ...r }));
  const latest = (scope) => rows.filter((r) => r.scope === scope).sort((a, b) => b.version - a.version)[0] || null;
  return {
    rows,
    current: () => [...new Set(rows.map((r) => r.scope))].map(latest).sort((a, b) => (b.scope === 'global') - (a.scope === 'global') || a.scope.localeCompare(b.scope)),
    versions: (scope) => rows.filter((r) => r.scope === scope).sort((a, b) => b.version - a.version).map(({ body, ...r }) => ({ ...r, chars: body.length })),
    version: (scope, v) => rows.find((r) => r.scope === scope && r.version === Number(v)) || null,
    save: (scope, body, edit_note, author_name = 'IT') => { const l = latest(scope); const row = { id: rows.length + 1, scope, version: l ? l.version + 1 : 1, body, edit_note, author_id: 6, author_name, created_at: '2026-11-23T13:00:00.000Z' }; rows.push(row); return row; },
  };
}

async function pane({ roles = 'su', loadFail = { after: 0 }, rows = [{ id: 1, scope: 'global', version: 1, body: 'Be brief.', edit_note: 'seed', author_id: null, author_name: 'seed', created_at: '2026-11-23T10:00:00.000Z' }], families = ['/api/casey', '/api/tasks'], saveError = null } = {}) {
  const dom = new JSDOM(HTML.replace('<script src="/themeSync.js"></script>', '').replace('<script src="/js/diag.js"></script>', ''), { runScripts: 'outside-only', url: 'https://app.test/caseyNotes.html', pretendToBeVisual: true });
  const w = dom.window;
  const db = store(rows);
  const calls = [];
  w.__parent = {
    firmData: { currentUser: { user: 6, username: 'IT', roles } },
    apiSend: async (p, method = 'GET', body) => {
      calls.push({ p, method, body });
      const u = new URL(p, 'https://x');
      if (u.pathname === '/api/casey/notes' && method === 'GET') { if (loadFail.after > 0 && --loadFail.after === 0) { const e = new Error('list gone'); e.status = 503; throw e; } return { status: 'success', scopes: db.current(), families, caps: { global: 20000, family: 2000, edit_note: 300 } }; }
      if (u.pathname === '/api/casey/notes/versions') return { status: 'success', versions: db.versions(u.searchParams.get('scope')) };
      if (u.pathname === '/api/casey/notes/version') { const v = db.version(u.searchParams.get('scope'), u.searchParams.get('v')); if (!v) { const e = new Error('No such version'); e.status = 404; throw e; } return { status: 'success', version: v }; }
      if (u.pathname === '/api/casey/notes' && method === 'PUT') { if (saveError) { const e = new Error(saveError); e.status = 400; throw e; } return { status: 'success', saved: db.save(body.scope, body.body, body.edit_note) }; }
      if (u.pathname === '/api/casey/notes/restore') { const old = db.version(body.scope, body.version); return { status: 'success', saved: db.save(body.scope, old.body, `Restored version ${old.version}`) }; }
      throw new Error('unexpected ' + method + ' ' + p);
    },
  };
  w.eval(PATCHED);
  await settle(10);
  const E = (id) => w.document.getElementById(id);
  const input = (id, v) => { E(id).value = v; E(id).dispatchEvent(new w.Event('input', { bubbles: true })); };
  return { w, d: w.document, E, input, calls, db, settle };
}

test('the gate: su and it see the editor; another role sees the refusal; no parent → not authenticated', async () => {
  for (const roles of ['su', 'it', 'admin,it']) { const p = await pane({ roles }); expect(p.E('main').hidden).toBe(false); }
  const no = await pane({ roles: 'admin,staff' });
  expect(no.d.body.textContent).toMatch(/for IT and superusers/);
  expect(no.calls).toHaveLength(0);
});

test('boot: the picker (Global first, the families, • where a note exists), the current body, the count, the versions table', async () => {
  const p = await pane({ rows: [
    { id: 1, scope: 'global', version: 1, body: 'Be brief.', edit_note: 'seed', author_id: null, author_name: 'seed', created_at: '2026-11-23T10:00:00.000Z' },
    { id: 2, scope: 'global', version: 2, body: 'Be brief and kind.', edit_note: 'kinder', author_id: 6, author_name: 'IT', created_at: '2026-11-23T11:00:00.000Z' },
    { id: 3, scope: '/api/tasks', version: 1, body: 'Use /complete.', edit_note: 'tasks', author_id: 6, author_name: 'IT', created_at: '2026-11-23T11:30:00.000Z' },
  ] });
  const opts = [...p.E('scope').options].map((o) => [o.value, o.textContent]);
  expect(opts).toEqual([['global', 'Global — every turn •'], ['/api/casey', '/api/casey'], ['/api/tasks', '/api/tasks •']]);
  expect(p.E('body').value).toBe('Be brief and kind.');
  expect(p.E('count').textContent).toBe('18 / 20,000 characters');
  expect(p.E('intro').textContent).toMatch(/appended to Casey's system prompt/);
  const rowsText = [...p.E('versions').querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td')].slice(0, 5).map((td) => td.textContent));
  expect(rowsText).toEqual([['2 (current)', expect.any(String), 'IT', 'kinder', '18'], ['1', expect.any(String), 'seed', 'seed', '9']]);
  expect(p.E('save').disabled && p.E('revert').disabled).toBe(true);
  expect(p.calls.map((c) => c.p)).toEqual(['/api/casey/notes', '/api/casey/notes/versions?scope=global']);
});

test('editing: Save needs a change AND an edit note AND the cap; the count turns red over the cap; Discard restores', async () => {
  const p = await pane();
  p.input('body', 'Be brief. Cite the table.');
  expect(p.E('save').disabled).toBe(true);           // no edit note yet
  expect(p.E('revert').disabled).toBe(false);
  p.input('editNote', 'cite');
  expect(p.E('save').disabled).toBe(false);
  p.input('body', 'x'.repeat(20001));
  expect(p.E('count').classList.contains('over')).toBe(true);
  expect(p.E('count').textContent).toBe('20,001 / 20,000 characters');
  expect(p.E('save').disabled).toBe(true);
  p.input('body', 'x'.repeat(20000));
  expect(p.E('count').classList.contains('over')).toBe(false);
  expect(p.E('save').disabled).toBe(false);
  p.E('revert').click();
  expect(p.E('body').value).toBe('Be brief.');
  expect(p.E('save').disabled && p.E('revert').disabled).toBe(true);
});

test('Save → PUT {scope, body, edit_note}; the page reloads and shows the new version; the status names the prompt change for global', async () => {
  const p = await pane();
  p.input('body', 'Be brief.\nName the table.');
  p.input('editNote', 'tables');
  p.E('save').click();
  await p.settle(12);
  const put = p.calls.find((c) => c.method === 'PUT');
  expect(put).toEqual({ p: '/api/casey/notes', method: 'PUT', body: { scope: 'global', body: 'Be brief.\nName the table.', edit_note: 'tables' } });
  expect(p.E('status').textContent).toMatch(/^Saved version 2 of global\. Casey's prompt has changed: chats already open pick it up on their next turn/);
  expect(p.E('versions').querySelectorAll('tr')).toHaveLength(2);
  expect(p.E('body').value).toBe('Be brief.\nName the table.');
  expect(p.E('editNote').value).toBe('');
  expect(p.E('save').disabled).toBe(true);
});

test('a refused save shows the server\'s reason and keeps the typing', async () => {
  const p = await pane({ saveError: 'unchanged: the current version already says exactly this' });
  p.input('body', 'Be brief.  ');
  p.input('editNote', 'n');
  p.E('save').click();
  await p.settle(12);
  expect(p.E('status').textContent).toBe('Not saved: unchanged: the current version already says exactly this');
  expect(p.E('status').className).toBe('status err');
  expect(p.E('body').value).toBe('Be brief.  ');
});

test('unsaved typing is never dropped by a scope change or Refresh: the picker snaps back with a message until Save or Discard (review S7)', async () => {
  const p = await pane();
  p.input('body', 'typed but not saved');
  p.E('scope').value = '/api/tasks';
  p.E('scope').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await p.settle(4);
  expect(p.E('scope').value).toBe('global');
  expect(p.E('body').value).toBe('typed but not saved');
  expect(p.E('status').textContent).toMatch(/unsaved changes.*before switching/);
  const n = p.calls.length;
  p.E('refresh').click();
  await p.settle(4);
  expect(p.calls.length).toBe(n);
  expect(p.E('status').textContent).toMatch(/before refreshing/);
  p.E('revert').click();
  p.E('scope').value = '/api/tasks';
  p.E('scope').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await p.settle(6);
  expect(p.E('scope').value).toBe('/api/tasks');
});

test('a save that went through is reported as saved even when the reload after it fails (review S8)', async () => {
  const p = await pane({ loadFail: { after: 2 } });   // the first GET /api/casey/notes is boot; the second (the reload) fails
  p.input('body', 'Be brief. New.'); p.input('editNote', 'n');
  p.E('save').click();
  await p.settle(12);
  expect(p.E('status').textContent).toMatch(/^Saved version 2 of global\..*The list could not be reloaded: list gone$/);
  expect(p.E('save').disabled).toBe(true);           // the editor shows the stored (normalised) body
  expect(p.E('body').value).toBe('Be brief. New.');
  expect(p.E('revert').disabled).toBe(true);
});

test('escaping: HTML in an author name, an edit note or a scope is text; the count is in code points; the status is a live region', async () => {
  const p = await pane({ rows: [{ id: 1, scope: 'global', version: 1, body: '😀 x', edit_note: '<img src=x onerror=alert(1)>', author_id: 6, author_name: '<b>bold</b>', created_at: '2026-11-23T10:00:00.000Z' }], families: ['/api/<script>bad</script>'] });
  expect(p.E('versions').querySelector('img')).toBeNull();
  expect(p.E('versions').querySelector('b')).toBeNull();
  expect(p.E('versions').textContent).toContain('<img src=x onerror=alert(1)>');
  expect(p.E('scope').querySelector('script')).toBeNull();
  expect([...p.E('scope').options].map((o) => o.value)).toContain('/api/<script>bad</script>');
  expect(p.E('count').textContent).toBe('3 / 20,000 characters');   // 😀 is one code point (two UTF-16 units)
  expect(p.E('status').getAttribute('aria-live')).toBe('polite');
});

test('a scope change loads that scope: a family with no note shows a blank body, its intro and its 2,000 cap; the versions table says so', async () => {
  const p = await pane();
  p.E('scope').value = '/api/tasks';
  p.E('scope').dispatchEvent(new p.w.Event('change', { bubbles: true }));
  await p.settle(8);
  expect(p.E('body').value).toBe('');
  expect(p.E('count').textContent).toBe('0 / 2,000 characters');
  expect(p.E('intro').textContent).toMatch(/route family \/api\/tasks/);
  expect(p.E('versions').textContent).toMatch(/No version yet/);
  expect(p.calls[p.calls.length - 1].p).toBe('/api/casey/notes/versions?scope=%2Fapi%2Ftasks');
  p.input('body', 'Use /complete.'); p.input('editNote', 'first');
  p.E('save').click();
  await p.settle(12);
  expect(p.calls.find((c) => c.method === 'PUT').body).toEqual({ scope: '/api/tasks', body: 'Use /complete.', edit_note: 'first' });
  expect(p.E('status').textContent).toBe('Saved version 1 of /api/tasks.');
});

test('View opens the viewer with that version\'s body; Restore posts {scope, version} and the page reloads; the current version cannot be restored', async () => {
  const p = await pane({ rows: [
    { id: 1, scope: 'global', version: 1, body: 'v1 text', edit_note: 'seed', author_id: null, author_name: 'seed', created_at: '2026-11-23T10:00:00.000Z' },
    { id: 2, scope: 'global', version: 2, body: 'v2 text', edit_note: 'two', author_id: 6, author_name: 'IT', created_at: '2026-11-23T11:00:00.000Z' },
  ] });
  p.E('versions').querySelector('button[data-view="2"]').click();
  await p.settle(6);
  expect(p.E('viewer').style.display).toBe('block');
  expect(p.E('vbody').textContent).toBe('v2 text');
  expect(p.E('restore').disabled).toBe(true);        // the current one
  p.E('versions').querySelector('button[data-view="1"]').click();
  await p.settle(6);
  expect(p.E('vtitle').textContent).toBe('Version 1 of global');
  expect(p.E('vbody').textContent).toBe('v1 text');
  expect(p.E('restore').disabled).toBe(false);
  p.input('body', 'typed, unsaved');   // Restore under the unsaved guard too (review r2 nit)
  p.E('restore').click();
  await p.settle(4);
  expect(p.E('status').textContent).toMatch(/before restoring a version/);
  expect(p.calls.some((c) => c.p === '/api/casey/notes/restore')).toBe(false);
  p.E('revert').click();
  p.input('editNote', 'v2 was wrong');
  p.E('restore').click();
  await p.settle(12);
  expect(p.calls.find((c) => c.p === '/api/casey/notes/restore')).toEqual({ p: '/api/casey/notes/restore', method: 'POST', body: { scope: 'global', version: 1, edit_note: 'v2 was wrong' } });
  expect(p.E('status').textContent).toBe('Restored version 1 as version 3 of global.');
  expect(p.E('body').value).toBe('v1 text');
  expect(p.E('viewer').style.display).toBe('none');
  p.E('versions').querySelector('button[data-view="1"]').click();
  await p.settle(6);
  p.E('vclose').click();
  expect(p.E('viewer').style.display).toBe('none');
});
