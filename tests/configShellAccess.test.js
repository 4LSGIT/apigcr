// tests/configShellAccess.test.js
//
/**
 * Settings arc §3b — the Config shell's side of the read-only handshake, and
 * its tabs. public/caseConfigManager.html runs for REAL (its whole inline
 * script) in a jsdom frame under a parent that plays index.html (apiSend,
 * with GET /api/ui-config answered when the test says). Sub-pages are
 * recorder pages written into the shell's own iframes — plus, end to end,
 * the REAL caseconfig/types.html.
 *
 * Locks: SUB_PAGES order / pages / gates; BOTH gated tabs (Firm ←
 * can_edit_firm, System ← can_edit_system) from ONE probe, only on === true;
 * a failed probe keeps both hidden and leaves configCanEdit null and calls no
 * onAccess; P.configCanEdit null → the answer; onAccess delivered to every
 * loaded sub-page when the answer arrives and to one that loads after it (the
 * iframe load event), never before it, and one throwing sub-page doesn't stop
 * the rest; the banner and the topbar Save / New / Delete per access (masked
 * while pending, hidden + banner when read-only, the topbar handlers refuse
 * too; Refresh never masked; a gated tab never read-only). The workspace
 * URL's pending gated sub-tab (Firm AND System) is in tests/wsurlS5ca.test.js.
 *
 * Mutation-checked (see the W5 worker report).
 *
 * Run:  npx jest tests/configShellAccess.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { makeSettingsApi } = require('./helpers/settingsApiFake');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CCM_HTML = read('public/caseConfigManager.html');
const TYPES_HTML = read('public/caseconfig/types.html');
const strip = (html) => html.replace(/<script src=[^>]*><\/script>/g, '').replace(/<link [^>]*>/g, '');
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const RO_FALSE = 'Read-only — changing YisraCase Config needs the admin permission.';
const RO_FAILED = 'Read-only — your permission to change YisraCase Config could not be checked. Reload to try again.';

// A sub-page that records the protocol. `throwOnAccess` → its onAccess throws.
const RECORDER = (throwOnAccess = false) => `<!DOCTYPE html><html><body><script>
  window.__access = []; window.__hooks = [];
  window.__initSaw = window.parent.configCanEdit;
  window.onAccess = function (a) { window.__access.push(a && a.canEdit); ${throwOnAccess ? "throw new Error('boom');" : ''} };
  ['onNew', 'onSave', 'onDelete', 'onRefresh'].forEach(function (h) { window[h] = function () { window.__hooks.push(h); }; });
  window.parent.setTopbarButtons({ save: true, delete: true, new: true, refresh: true });
</script></body></html>`;

function writeFrame(iframe, html) {
  const d = iframe.contentWindow.document;
  d.open(); d.write(html); d.close();
  return iframe.contentWindow;
}

/** The parent (index.html's part) + the shell. GET /api/ui-config waits for
 *  release(answer | Error) unless `answer` is given up front. */
async function boot({ answer, extra = {} } = {}) {
  const vc = new VirtualConsole();
  const logs = [];
  vc.on('warn', (...a) => logs.push(a.join(' ')));
  const top = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true, virtualConsole: vc }).window;
  const calls = [];
  let release;
  const probe = new Promise((r) => { release = r; });
  top.apiSend = async (url, method = 'GET') => {
    calls.push(`${method} ${url}`);
    if (url === '/api/ui-config') {
      const a = await probe;
      if (a instanceof Error) throw a;
      return a;
    }
    if (extra[url]) return extra[url]();
    return {};
  };
  const f = top.document.createElement('iframe');
  top.document.body.appendChild(f);
  await flush(5);
  const mid = writeFrame(f, strip(CCM_HTML));
  await flush();
  const t = {
    top, mid, calls, logs,
    release: async (a) => { release(a); await flush(); },
    $: (id) => mid.document.getElementById(id),
    frame: (id) => mid.document.getElementById(`subpage-${id}`),
    /** Show a sub-tab and load a page into its iframe (as its src would). */
    load: async (id, html = RECORDER()) => {
      mid.switchSubPage(id);
      const w = writeFrame(t.frame(id), html);
      await flush();
      return w;
    },
    visibleTabs: () => [...mid.document.querySelectorAll('.tab-nav-btn')].filter((b) => !b.hidden).map((b) => b.id.replace(/^tabnav-/, '')),
    shownButtons: () => ['save', 'delete', 'refresh', 'new'].filter((k) => t.$(`btn-${k}`).style.display !== 'none'),
    banner: () => (t.$('ro-banner').hidden ? null : t.$('ro-banner-text').textContent),
  };
  if (answer !== undefined) await t.release(answer);
  return t;
}

// ─────────────────────────────────────────────────────────────────────────
describe('SUB_PAGES: the tabs, their pages, their gates', () => {
  test('order: Types & Subtypes, Pipelines, Custom Fields, Contact Roles, Calendar Types, Lists, Firm, System — the last two gated', async () => {
    const t = await boot();   // probe pending: every gated tab still hidden
    const tabs = [...t.mid.document.querySelectorAll('.tab-nav-btn')].map((b) => {
      const id = b.id.replace(/^tabnav-/, '');
      const fr = t.frame(id);
      return [id, b.textContent.trim(), fr.dataset.src || fr.getAttribute('src'), b.hidden];
    });
    expect(tabs).toEqual([
      ['types', 'Types & Subtypes', '/caseconfig/types.html', false],
      ['pipelines', 'Pipelines', '/caseconfig/pipelines.html', false],
      ['fields', 'Custom Fields', '/caseconfig/fields.html', false],
      ['contactroles', 'Contact Roles', '/caseconfig/contactRoles.html', false],
      ['caltypes', 'Calendar Types', '/caseconfig/calendarTypes.html', false],
      ['lists', 'Lists', '/caseconfig/lists.html', false],
      ['firm', 'Firm', '/caseconfig/firm.html', true],
      ['system', 'System', '/caseconfig/system.html', true],
    ]);
    // every page this branch ships exists (contactRoles.html is the tool-homes lane's)
    for (const [, , src] of tabs) {
      if (src === '/caseconfig/contactRoles.html') continue;
      expect([src, fs.existsSync(path.join(ROOT, 'public', src))]).toEqual([src, true]);
    }
  });

  // Settings arc W7: Lists and System are the real pages now (their own
  // behaviour: tests/configListsTab.test.js, tests/configSystemTab.test.js).
  // Kept here: they follow the sub-page protocol under the real shell.
  test('the Lists and System pages follow the sub-page protocol: they boot under the shell, ask only for Refresh while clean, expose the hooks, read with ONE GET, and write nothing on their own', async () => {
    const ROWS_TAG = '<script src="/js/ycSettingRows.js"></script>';
    const ROWS = read('public/js/ycSettingRows.js');
    const withRows = (html) => strip(html.replace(ROWS_TAG, () => `<script>${ROWS}</script>`));
    for (const [id, file, gate, home] of [['lists', 'lists.html', null, 'config'], ['system', 'system.html', { can_edit_system: true }, 'system,comms']]) {
      const fake = makeSettingsApi({ caps: { firm: true, system: true } });
      const url = `/api/app-settings?home=${home}`;
      const t = await boot({ answer: { can_edit_firm: true, ...(gate || {}) }, extra: { [url]: () => fake.api(url) } });
      const w = await t.load(id, withRows(read(`public/caseconfig/${file}`)));
      expect(t.mid.document.querySelector('.tab-nav-btn.active').id).toBe(`tabnav-${id}`);
      expect(w.document.body.textContent).not.toMatch(/coming in this arc/);           // the placeholders are gone
      expect([id, w.document.querySelectorAll('.ycsr-row').length > 0]).toEqual([id, true]);
      for (const h of ['onShow', 'onHide', 'onSave', 'onRefresh', 'onAccess']) expect([id, h, typeof w[h]]).toEqual([id, h, 'function']);
      expect(t.shownButtons()).toEqual(['refresh']);
      expect(t.calls.filter((c) => c.startsWith('GET /api/app-settings') || c === 'GET /api/ui-config')).toEqual(['GET /api/ui-config', `GET ${url}`]);
      w.onAccess({ canEdit: false }); w.onShow(); w.onRefresh(); await w.onSave();
      await flush();
      expect([id, t.calls.filter((c) => !c.startsWith('GET '))]).toEqual([id, []]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the gated tabs: Firm and System, both from ONE GET /api/ui-config', () => {
  test.each([
    [{ can_edit_firm: true, can_edit_system: true }, ['firm', 'system']],
    [{ can_edit_firm: true, can_edit_system: false }, ['firm']],
    [{ can_edit_firm: true }, ['firm']],
    [{ can_edit_firm: false, can_edit_system: true }, ['system']],
    [{ can_edit_firm: false, can_edit_system: false }, []],
    [{ can_edit_firm: 'true', can_edit_system: 1 }, []],             // only === true reveals
    [{}, []],
  ])('%j → gated tabs shown: %j', async (answer, gated) => {
    const t = await boot({ answer });
    expect(t.visibleTabs()).toEqual(['types', 'pipelines', 'fields', 'contactroles', 'caltypes', 'lists', ...gated]);
    expect(t.calls).toEqual(['GET /api/ui-config']);
    for (const id of ['firm', 'system']) {
      t.mid.switchSubPage(id);                                       // a hidden gated tab is refused
      expect([id, t.mid.document.querySelector('.tab-nav-btn.active').id]).toEqual([id, gated.includes(id) ? `tabnav-${id}` : 'tabnav-types']);
      t.mid.switchSubPage('types');
    }
  });

  test('a failed probe keeps both hidden, leaves configCanEdit null, calls no onAccess, and says why it is read-only', async () => {
    const t = await boot();
    const types = await t.load('types');
    await t.release(Object.assign(new Error('offline'), { status: 500 }));
    expect(t.visibleTabs()).toEqual(['types', 'pipelines', 'fields', 'contactroles', 'caltypes', 'lists']);
    expect(t.mid.configCanEdit).toBeNull();
    expect(types.__access).toEqual([]);
    expect(t.logs.join('\n')).toMatch(/Firm tab stays hidden, as does System/);
    expect(t.banner()).toBe(RO_FAILED);
    expect(t.shownButtons()).toEqual(['refresh']);
    // a sub-page loading later hears nothing either: it is read-only from its own init (null)
    const late = await t.load('pipelines');
    t.frame('pipelines').dispatchEvent(new t.mid.Event('load'));
    await flush();
    expect([late.__initSaw, late.__access]).toEqual([null, []]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('P.configCanEdit and onAccess', () => {
  test('configCanEdit: null while the probe runs; then === true, else false', async () => {
    for (const [answer, want] of [[{ can_edit_firm: true }, true], [{ can_edit_firm: false }, false],
      [{ can_edit_firm: 'true' }, false], [{ can_edit_system: true }, false], [{}, false], [null, false]]) {
      const t = await boot();
      expect(t.mid.configCanEdit).toBeNull();
      await t.release(answer);
      expect([answer, t.mid.configCanEdit]).toEqual([answer, want]);
    }
  });

  test.each([[true], [false]])('canEdit %s: every LOADED sub-page hears it when the answer arrives, not before; a LATER one hears it on load (and saw it at init)', async (canEdit) => {
    const t = await boot();
    const types = await t.load('types');
    const pipes = await t.load('pipelines');
    expect([types.__initSaw, types.__access, pipes.__initSaw, pipes.__access]).toEqual([null, [], null, []]);
    await t.release({ can_edit_firm: canEdit });
    expect([types.__access, pipes.__access]).toEqual([[canEdit], [canEdit]]);
    // loads after the answer: its init read the getter; the browser's load event delivers it too
    const fields = await t.load('fields');
    expect([fields.__initSaw, fields.__access]).toEqual([canEdit, []]);
    t.frame('fields').dispatchEvent(new t.mid.Event('load'));
    await flush();
    expect(fields.__access).toEqual([canEdit]);
    expect([types.__access, pipes.__access]).toEqual([[canEdit], [canEdit]]);   // nobody else re-told
  });

  test('a sub-page whose onAccess throws does not stop the others hearing it', async () => {
    const t = await boot();
    const types = await t.load('types', RECORDER(true));
    const pipes = await t.load('pipelines');
    await t.release({ can_edit_firm: true });
    expect([types.__access, pipes.__access]).toEqual([[true], [true]]);
    expect(t.logs.join('\n')).toMatch(/types: onAccess failed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the read-only chrome: banner + topbar Save / New / Delete', () => {
  test('read-only (answer false) on a vocabulary tab: banner shown, Save / New / Delete hidden and refused, Refresh kept', async () => {
    const t = await boot({ answer: { can_edit_firm: false } });
    const w = await t.load('types');
    expect(t.banner()).toBe(RO_FALSE);
    expect(t.shownButtons()).toEqual(['refresh']);
    t.mid.onTopbarSave(); t.mid.onTopbarNew(); t.mid.onTopbarDelete(); t.mid.onTopbarRefresh();
    expect(w.__hooks).toEqual(['onRefresh']);
    // every vocabulary tab, the same
    for (const id of ['pipelines', 'fields', 'contactroles', 'caltypes', 'lists']) {
      await t.load(id);
      expect([id, t.banner(), t.shownButtons()]).toEqual([id, RO_FALSE, ['refresh']]);
    }
  });

  test('editable (answer true): no banner, every button the sub-page asked for, the handlers delegate — byte for byte as before', async () => {
    const t = await boot({ answer: { can_edit_firm: true } });
    const w = await t.load('types');
    expect(t.banner()).toBeNull();
    expect(t.shownButtons()).toEqual(['save', 'delete', 'refresh', 'new']);
    t.mid.onTopbarSave(); t.mid.onTopbarNew(); t.mid.onTopbarDelete(); t.mid.onTopbarRefresh();
    expect(w.__hooks).toEqual(['onSave', 'onNew', 'onDelete', 'onRefresh']);
    expect(t.$('ro-banner').hidden).toBe(true);
  });

  test('while the probe runs: Save / New / Delete masked (fail closed), no banner yet; the answer reveals them', async () => {
    const t = await boot();
    const w = await t.load('types');
    expect([t.banner(), t.shownButtons()]).toEqual([null, ['refresh']]);
    t.mid.onTopbarNew();
    expect(w.__hooks).toEqual([]);
    await t.release({ can_edit_firm: true });
    expect([t.banner(), t.shownButtons()]).toEqual([null, ['save', 'delete', 'refresh', 'new']]);
  });

  test('a gated tab is never read-only: System shown for a non-firm holder keeps its buttons and no banner; back on a vocabulary tab it is read-only again', async () => {
    const t = await boot({ answer: { can_edit_firm: false, can_edit_system: true } });
    const w = await t.load('system');
    expect([t.banner(), t.shownButtons()]).toEqual([null, ['save', 'delete', 'refresh', 'new']]);
    t.mid.onTopbarSave();
    expect(w.__hooks).toEqual(['onSave']);
    await t.load('types');
    expect([t.banner(), t.shownButtons()]).toEqual([RO_FALSE, ['refresh']]);
  });

  test('the banner is a plain flex item between the topbar and the panels, text by class (no inline font / colour)', () => {
    const dom = new JSDOM(strip(CCM_HTML));
    const b = dom.window.document.getElementById('ro-banner');
    expect(b.previousElementSibling.id).toBe('topbar');
    expect(b.nextElementSibling.id).toBe('subpages-root');
    expect([b.className, b.getAttribute('style'), b.hidden]).toEqual(['ro-banner', null, true]);
    expect(CCM_HTML).toMatch(/\.ro-banner \{\s*flex: 0 0 auto;/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('end to end: the real shell tells the real Types & Subtypes page', () => {
  const SWAL = '<script>window.Swal = { mixin: function () { return { fire: function () {} }; }, fire: function () { return Promise.resolve({}); } };</script>';
  const TYPES = strip(TYPES_HTML.replace('<script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>', SWAL));
  const extra = { '/api/app-settings': () => ({ status: 'success', settings: [{ key: 'fe-case_types', value: '{"Bankruptcy":["Chapter 7"]}' }] }) };
  const newType = (w) => w.document.querySelector('.toolbar [onclick="addType()"]');

  test.each([[true], [false]])('loaded before the answer (read-only at init), then told canEdit %s', async (canEdit) => {
    const t = await boot({ extra });
    const w = await t.load('types', TYPES);
    expect(w.document.body.classList.contains('cc-ro')).toBe(true);
    expect(w.getComputedStyle(newType(w)).display).toBe('none');
    expect(w.document.querySelector('.type-name').firstChild.textContent.trim()).toBe('Bankruptcy');   // viewing works
    await t.release({ can_edit_firm: canEdit });
    expect(w.document.body.classList.contains('cc-ro')).toBe(!canEdit);
    expect(w.getComputedStyle(newType(w)).display).toBe(canEdit ? 'inline-flex' : 'none');
  });

  test('loaded after a true answer: editable from its own init', async () => {
    const t = await boot({ extra, answer: { can_edit_firm: true } });
    const w = await t.load('types', TYPES);
    expect(w.document.body.classList.contains('cc-ro')).toBe(false);
    expect(t.calls.filter((c) => !c.startsWith('GET ')).length).toBe(0);
  });
});
