// tests/iconPickerS6a.test.js
//
/**
 * ui-custom S6a — the icon picker (public/js/ycIconPicker.js), for real in
 * jsdom with the real ycIcon.js and the real committed catalog (served by a
 * fetch stub that counts its calls).
 *
 *   1. Lazy: loading the script fetches nothing; the first open fetches the
 *      catalog once; later opens reuse it; a failed load says so and retries.
 *   2. The current value is highlighted (solid bare or prefixed, regular,
 *      brands) and named; an unknown or invalid one is said.
 *   3. Search: name, terms and old alias names; every word must match;
 *      ranking; "no match" is text. Family chips filter.
 *   4. Pick resolves the stored value (solid bare, regular:/brands: prefixed);
 *      Esc / × / Cancel / the backdrop / a second open resolve null; "No icon"
 *      only with allowEmpty.
 *   5. Keyboard: ↓ into the grid, arrows, ↑ back to the search, Home / End,
 *      Enter / Space pick, Enter in the search picks the first match, Tab
 *      cycles inside; no keydown escapes the dialog while it is open.
 *   6. Escaping: the title and the query are text; every tile's class is
 *      fa-<family> fa-<slug>; a hostile catalog row never becomes a tile.
 *   7. Incremental: a first chunk only; scrolling and End draw more.
 *   8. From a same-origin iframe: drawn in the TOP document, resolves into
 *      the frame, focus goes back to the frame's button.
 *   9. Settings → My Custom Tab (the real settings.html in a frame under a
 *      stub shell): Choose… opens the top picker; the choice previews with
 *      its family and is what Save posts; the old icon grid is gone.
 *
 * The layout editor (My buttons) and the Firm tab use it too: see the S6a
 * cases in tests/launcherS5a.test.js and tests/firmTab.test.js.
 *
 * Mutation-checked (see the S6a worker report).
 *
 * Run:  npx jest tests/iconPickerS6a.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const PICKER_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIconPicker.js'), 'utf8');
const CATALOG_URL = PICKER_SRC.match(/var CATALOG_URL = '([^']+)';/)[1];
const CATALOG = fs.readFileSync(path.join(ROOT, 'public', CATALOG_URL), 'utf8');
const SETTINGS_HTML = fs.readFileSync(path.join(ROOT, 'public/settings.html'), 'utf8');

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const okJson = (text) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(text)) });

// every window this file opens is closed after its test (review N4: a run of
// this file alone must exit cleanly — settings.html's frame keeps timers)
const DOMS = [];
afterEach(() => { while (DOMS.length) DOMS.pop().window.close(); });

function shell({ catalog = CATALOG, fail = 0 } = {}) {
  const vc = new VirtualConsole();
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><button id="opener">Choose…</button><iframe id="pane"></iframe></body></html>',
    { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://app.example/', virtualConsole: vc });
  DOMS.push(dom);
  const w = dom.window;
  const fetches = [];
  let failsLeft = fail;
  w.fetch = (url) => {
    fetches.push(String(url));
    if (failsLeft > 0) { failsLeft--; return Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new Error('no')) }); }
    return okJson(catalog);
  };
  w.eval(ICON_SRC);
  w.eval(PICKER_SRC);
  const d = w.document;
  const P = w.ycIconPicker;
  const root = () => d.getElementById('ycIconPicker');
  const q = () => root().querySelector('.yip-q');
  const tiles = () => [...root().querySelectorAll('.yip-tile')];
  const vals = () => tiles().map((t) => t.getAttribute('data-v'));
  const chip = (fam) => root().querySelector(`.yip-chip[data-fam="${fam}"]`);
  const key = (k, init = {}, target = d.activeElement) => {
    const e = new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };
  const type = (s) => { q().value = s; q().dispatchEvent(new w.Event('input', { bubbles: true })); };
  /** open and wait for the catalog; returns { p, result() } */
  const open = async (opts) => {
    let out = { done: false, value: undefined };
    const p = P.open(opts).then((v) => { out = { done: true, value: v }; return v; });
    await flush();
    return { p, out: () => out };
  };
  return { dom, w, d, P, fetches, root, q, tiles, vals, chip, key, type, open };
}

// ─────────────────────────────────────────────────────────────────────────
describe('lazy catalog', () => {
  test('no fetch before the first open; one fetch for any number of opens; the dialog is built on first open', async () => {
    const t = shell();
    await flush();
    expect(t.fetches).toEqual([]);
    expect(t.d.getElementById('ycIconPicker')).toBe(null);
    expect(t.d.getElementById('ycIconPickerCss')).toBe(null);
    const a = await t.open({ value: 'star' });
    expect(t.fetches).toEqual([CATALOG_URL]);
    expect(t.d.getElementById('ycIconPickerCss')).not.toBe(null);
    expect(t.tiles().length).toBeGreaterThan(0);
    t.key('Escape');
    await a.p;
    const b = await t.open({ value: 'star' });
    expect(t.fetches).toEqual([CATALOG_URL]);
    expect(t.tiles().length).toBeGreaterThan(0);
    t.key('Escape');
    expect(await b.p).toBe(null);
  });

  test('two opens while the catalog is still loading share ONE fetch', async () => {
    const t = shell();
    const a = t.P.open({ value: 'star' });                           // no flush: the fetch is in flight
    const b = t.P.open({ value: 'regular:star' });                   // cancels a; must reuse the pending load
    expect(await a).toBe(null);
    await flush();
    expect(t.fetches).toEqual([CATALOG_URL]);
    expect(t.root().querySelector('.is-current').getAttribute('data-v')).toBe('regular:star');
    t.key('Escape');
    expect(await b).toBe(null);
  });

  test('a failed load says so, offers Try again, and a retry loads it', async () => {
    const t = shell({ fail: 1 });
    const a = await t.open({ value: '' });
    expect(t.root().querySelector('.yip-msg').textContent).toMatch(/could not be loaded/);
    expect(t.tiles()).toEqual([]);
    t.root().querySelector('[data-yip="retry"]').click();
    await flush();
    expect(t.fetches).toEqual([CATALOG_URL, CATALOG_URL]);
    expect(t.tiles().length).toBeGreaterThan(0);
    expect(t.root().querySelector('.yip-msg').textContent).toBe('');
    t.key('Escape');
    await a.p;
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the current value', () => {
  test.each([
    ['brands:github', 'brands:github', 'github · Brands'],
    ['regular:star', 'regular:star', 'star · Regular'],
    ['star', 'star', 'star · Solid'],
    ['solid:star', 'star', 'star · Solid'],
    ['wrench', 'wrench', 'wrench · Solid'],                       // far down the list: drawn up to it
  ])('%s is highlighted (tile %s) and named', async (value, tile, named) => {
    const t = shell();
    const a = await t.open({ value });
    const cur = t.tiles().filter((b) => b.classList.contains('is-current'));
    expect(cur.map((b) => b.getAttribute('data-v'))).toEqual([tile]);
    expect(cur[0].getAttribute('aria-selected')).toBe('true');
    expect(t.tiles().filter((b) => b.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(t.root().querySelector('.yip-cur').textContent).toBe('Current:' + named);
    expect(cur[0].tabIndex).toBe(0);                                  // it is the active tile
    t.key('Escape');
    await a.p;
  });

  test('an unknown name, an invalid value and no value are said, and nothing is highlighted', async () => {
    const t = shell();
    let a = await t.open({ value: 'home' });                          // an old alias: valid, not a tile
    expect(t.root().querySelector('.yip-cur').textContent).toBe('Current:home · Solid (not in the list)');
    expect(t.root().querySelectorAll('.is-current')).toHaveLength(0);
    t.key('Escape'); await a.p;
    a = await t.open({ value: 'bad" onmouseover="x' });
    expect(t.root().querySelector('.yip-cur').textContent).toBe('Current:not a valid icon name');
    expect(t.root().querySelector('.yip-cur i').className).toBe('fa-solid fa-circle-question');
    t.key('Escape'); await a.p;
    a = await t.open({});
    expect(t.root().querySelector('.yip-cur').textContent).toBe('Current: no icon');
    t.key('Escape'); await a.p;
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('search and family filter', () => {
  test('All shows every free icon in every family it is free in; the chips filter to one family', async () => {
    const t = shell();
    const a = await t.open({ value: '' });
    const count = () => t.root().querySelector('.yip-hover').textContent;
    expect(count()).toBe('2,034 icons');
    t.chip('brands').click();
    expect(count()).toBe('481 icons');
    expect(t.chip('brands').getAttribute('aria-checked')).toBe('true');
    expect(t.chip('').getAttribute('aria-checked')).toBe('false');
    expect(t.vals().every((v) => v.startsWith('brands:'))).toBe(true);
    t.chip('regular').click();
    expect(count()).toBe('163 icons');
    expect(t.vals().every((v) => v.startsWith('regular:'))).toBe(true);
    t.chip('solid').click();
    expect(count()).toBe('1,390 icons');
    expect(t.vals().every((v) => !v.includes(':'))).toBe(true);       // solid tiles carry the bare value
    t.chip('').click();
    expect(count()).toBe('2,034 icons');
    t.key('Escape'); await a.p;
  });

  test('matches names, terms and old alias names; every word must match; best name matches first', async () => {
    const t = shell();
    const a = await t.open({ value: '' });
    t.type('github');
    expect(t.vals().slice(0, 3)).toEqual(['brands:github', 'brands:github-alt', 'brands:square-github']);
    t.type('octocat');                                                // a search term only
    expect(t.vals()).toEqual(expect.arrayContaining(['brands:github', 'brands:github-alt']));
    t.type('home');                                                   // FA 5's name for house
    expect(t.vals()).toContain('house');
    t.type('  STAR  ');                                               // trimmed, case-folded
    expect(t.vals().slice(0, 2)).toEqual(['star', 'regular:star']);
    t.type('star half');                                              // both words
    expect(t.vals().length).toBeGreaterThan(0);
    expect(t.vals().every((v) => /star-half/.test(v))).toBe(true);
    t.chip('regular').click();
    expect(t.vals()).toEqual(['regular:star-half', 'regular:star-half-stroke']);
    t.chip('').click();
    t.type('zzzz <b>no</b>');
    expect(t.tiles()).toEqual([]);
    const msg = t.root().querySelector('.yip-msg');
    expect(msg.textContent).toBe('No icons match “zzzz <b>no</b>”.');
    expect(msg.querySelector('b')).toBe(null);
    t.key('Escape'); await a.p;
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('picking and cancelling', () => {
  test.each([['brands:github', 'github', 'brands'], ['regular:star', 'star', 'regular'], ['star', 'star', 'solid']])(
    'a click on the %s tile resolves %j', async (want, query, fam) => {
      const t = shell();
      const a = await t.open({ value: 'gavel' });
      t.type(query);
      t.chip(fam).click();
      t.tiles()[0].click();
      expect(await a.p).toBe(want);
      expect(t.root().hidden).toBe(true);
      expect(t.P.isOpen()).toBe(false);
    });

  test.each([
    ['Esc', (t) => t.key('Escape')],
    ['×', (t) => t.root().querySelector('.yip-x').click()],
    ['Cancel', (t) => t.root().querySelector('.yip-cancel').click()],
    ['the backdrop', (t) => { const b = t.root().querySelector('.yip-back'); b.dispatchEvent(new t.w.MouseEvent('mousedown', { bubbles: true })); b.click(); }],
    ['close()', (t) => t.P.close()],
  ])('%s resolves null', async (_, act) => {
    const t = shell();
    const a = await t.open({ value: 'star' });
    act(t);
    expect(await a.p).toBe(null);
    expect(t.root().hidden).toBe(true);
  });

  test('a press that starts in the card and ends on the backdrop does not cancel', async () => {
    const t = shell();
    const a = await t.open({ value: 'star' });
    t.root().querySelector('.yip-box').dispatchEvent(new t.w.MouseEvent('mousedown', { bubbles: true }));
    t.root().querySelector('.yip-back').click();
    expect(t.P.isOpen()).toBe(true);
    t.key('Escape'); await a.p;
  });

  test('a second open cancels the first (null) and shows the new one', async () => {
    const t = shell();
    const a = await t.open({ value: 'star', title: 'First' });
    const b = await t.open({ value: 'brands:github', title: 'Second' });
    expect(await a.p).toBe(null);
    expect(t.root().querySelector('#yipTitle').textContent).toBe('Second');
    expect(t.root().querySelector('.is-current').getAttribute('data-v')).toBe('brands:github');
    t.type('star');
    t.chip('regular').click();
    t.tiles()[0].click();
    expect(await b.p).toBe('regular:star');
  });

  test('"No icon" only where the field allows empty; it resolves the empty string', async () => {
    const t = shell();
    let a = await t.open({ value: 'star' });
    expect(t.root().querySelector('.yip-none').hidden).toBe(true);
    t.root().querySelector('.yip-none').click();                      // hidden and inert
    expect(t.P.isOpen()).toBe(true);
    t.key('Escape'); await a.p;
    a = await t.open({ value: 'star', allowEmpty: true });
    expect(t.root().querySelector('.yip-none').hidden).toBe(false);
    t.root().querySelector('.yip-none').click();
    expect(await a.p).toBe('');
  });

  test('focus goes back to `from` on close', async () => {
    const t = shell();
    const opener = t.d.getElementById('opener');
    const a = await t.open({ value: 'star', from: opener });
    expect(t.d.activeElement).toBe(t.q());
    t.key('Escape'); await a.p;
    expect(t.d.activeElement).toBe(opener);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('keyboard', () => {
  test('↓ enters the grid at the current icon; arrows move; ↑ from the top row returns to the search; Enter picks', async () => {
    const t = shell();
    const a = await t.open({ value: '' });
    expect(t.d.activeElement).toBe(t.q());
    t.key('ArrowDown');
    const at = () => Number(t.d.activeElement.getAttribute('data-i'));
    expect(at()).toBe(0);
    t.key('ArrowRight'); expect(at()).toBe(1);
    t.key('ArrowLeft'); expect(at()).toBe(0);
    t.key('ArrowLeft'); expect(at()).toBe(0);                          // clamped
    t.key('ArrowDown'); expect(at()).toBe(8);                          // a row (no layout in jsdom: 8 columns)
    t.key('PageDown'); expect(at()).toBe(40);
    t.key('PageUp'); expect(at()).toBe(8);
    t.key('ArrowUp'); expect(at()).toBe(0);
    t.key('ArrowUp'); expect(t.d.activeElement).toBe(t.q());           // back to the search box
    t.key('ArrowDown'); expect(at()).toBe(0);                          // the active tile is remembered
    t.key('ArrowRight'); t.key('ArrowRight');
    const v = t.d.activeElement.getAttribute('data-v');
    expect(t.d.activeElement.tabIndex).toBe(0);
    expect(t.tiles().filter((x) => x.tabIndex === 0)).toHaveLength(1);  // one tab stop
    t.key('Enter');
    expect(await a.p).toBe(v);
  });

  test('Space picks; ↓ from the search starts at the current icon', async () => {
    const t = shell();
    const a = await t.open({ value: 'regular:star' });
    t.key('ArrowDown');
    expect(t.d.activeElement.getAttribute('data-v')).toBe('regular:star');
    t.key('ArrowRight');
    const v = t.d.activeElement.getAttribute('data-v');
    t.key(' ');
    expect(await a.p).toBe(v);
  });

  test('Enter in the search box picks the first match once you type; with no query, the current icon', async () => {
    const t = shell();
    let a = await t.open({ value: 'gavel' });
    t.type('gith');
    t.key('Enter', {}, t.q());
    expect(await a.p).toBe('brands:github');
    a = await t.open({ value: 'gavel' });
    t.key('Enter', {}, t.q());
    expect(await a.p).toBe('gavel');
  });

  test('Home / End; End draws the whole list', async () => {
    const t = shell();
    const a = await t.open({ value: '' });
    t.key('ArrowDown');
    t.key('End');
    expect(t.tiles().length).toBe(2034);
    expect(t.d.activeElement.getAttribute('data-i')).toBe('2033');
    t.key('Home');
    expect(t.d.activeElement.getAttribute('data-i')).toBe('0');
    t.key('Escape'); await a.p;
  });

  test('Tab cycles inside the dialog both ways; chips move with ← / →', async () => {
    const t = shell();
    const a = await t.open({ value: 'star' });
    const seen = [];
    for (let i = 0; i < 6; i++) { t.key('Tab'); seen.push(t.d.activeElement.className.split(' ')[0]); }
    expect(seen).toEqual(['yip-chip', 'yip-tile', 'yip-btn', 'yip-x', 'yip-q', 'yip-chip']);
    t.key('ArrowRight');
    expect(t.d.activeElement.getAttribute('data-fam')).toBe('solid');
    expect(t.chip('solid').getAttribute('aria-checked')).toBe('true');
    t.key('Tab', { shiftKey: true });
    expect(t.d.activeElement).toBe(t.q());
    t.key('Tab', { shiftKey: true });
    expect(t.d.activeElement.className).toBe('yip-x');
    t.key('Tab', { shiftKey: true });
    expect(t.d.activeElement.className).toContain('yip-cancel');
    t.key('Escape'); await a.p;
  });

  test('while open, no keydown reaches the page behind it (an editor\'s Esc, Ctrl-K, shortcuts); after close they do again', async () => {
    const t = shell();
    const heard = [];
    t.d.addEventListener('keydown', (e) => heard.push(e.key));
    const a = await t.open({ value: 'star' });
    t.key('k', { ctrlKey: true });
    t.key('ArrowDown');
    t.key('Tab');
    t.key('Escape');
    await a.p;
    expect(heard).toEqual([]);
    t.key('Escape', {}, t.d.body);
    expect(heard).toEqual(['Escape']);
  });

  test('review SF1: after Try again, focus is in the dialog; a key aimed at <body> is caught by the document guard (Esc cancels), never heard behind', async () => {
    const t = shell({ fail: 1 });
    const heard = [];
    t.d.addEventListener('keydown', (e) => heard.push(e.key));          // the layout editor's / palette's level
    t.d.body.addEventListener('keydown', (e) => heard.push('body:' + e.key));
    const a = await t.open({ value: 'star' });
    const retry = t.root().querySelector('[data-yip="retry"]');
    retry.focus();
    retry.click();
    await flush();
    expect(t.tiles().length).toBeGreaterThan(0);
    expect(t.root().contains(t.d.activeElement)).toBe(true);            // not <body>
    expect(t.d.activeElement).toBe(t.q());
    // focus falls to <body> anyway (any path): a letter refocuses the search, Tab too; nothing is heard
    t.d.activeElement.blur();
    expect(t.d.activeElement).toBe(t.d.body);
    const k = t.key('k', { ctrlKey: true }, t.d.body);
    expect(k.defaultPrevented).toBe(false);
    expect(t.d.activeElement).toBe(t.q());
    t.d.activeElement.blur();
    expect(t.key('Tab', {}, t.d.body).defaultPrevented).toBe(true);
    expect(t.d.activeElement).toBe(t.q());
    t.d.activeElement.blur();
    const esc = t.key('Escape', {}, t.d.body);
    expect(esc.defaultPrevented).toBe(true);
    expect(await a.p).toBe(null);                                         // the picker handled it: cancelled
    expect(heard).toEqual([]);
    // the guard is gone with the dialog: keys reach the page again
    t.key('Escape', {}, t.d.body);
    expect(heard).toEqual(['body:Escape', 'Escape']);
  });

  test('review SF1: the guard follows the session — removed on cancel-by-reopen and re-added once for the new one', async () => {
    const t = shell();
    const heard = [];
    t.d.addEventListener('keydown', (e) => heard.push(e.key));
    const a = await t.open({ value: 'star' });
    const b = await t.open({ value: 'gavel' });
    expect(await a.p).toBe(null);
    t.key('Escape', {}, t.d.body);
    expect(await b.p).toBe(null);
    expect(heard).toEqual([]);
    t.key('x', {}, t.d.body);
    expect(heard).toEqual(['x']);
  });

  test('review SF1: a press on the backdrop never blurs (mousedown default prevented); one on the card does not', async () => {
    const t = shell();
    const a = await t.open({ value: 'star' });
    const down = (el) => { const e = new t.w.MouseEvent('mousedown', { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
    expect(down(t.root().querySelector('.yip-back'))).toBe(true);
    expect(down(t.root().querySelector('.yip-box'))).toBe(false);
    t.key('Escape'); await a.p;
  });

  test('the card takes focus on a click on its bare surface (so a key never lands on <body>)', async () => {
    const t = shell();
    const a = await t.open({ value: 'star' });
    const box = t.root().querySelector('.yip-box');
    expect(box.tabIndex).toBe(-1);
    box.focus();
    expect(t.d.activeElement).toBe(box);
    t.key('Escape');
    expect(await a.p).toBe(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('escaping and incremental drawing', () => {
  test('title is text; every tile class is fa-<family> fa-<slug>; names ride in title / aria-label attributes', async () => {
    const t = shell();
    const a = await t.open({ value: 'star', title: '<img src=x id=pwn> Icon for “X”' });
    expect(t.root().querySelector('#yipTitle').textContent).toBe('<img src=x id=pwn> Icon for “X”');
    expect(t.d.getElementById('pwn')).toBe(null);
    t.key('ArrowDown'); t.key('End');
    for (const b of t.tiles()) {
      expect(b.firstChild.className).toMatch(/^fa-(solid|regular|brands) fa-[a-z0-9-]{1,40}$/);
      expect(b.getAttribute('title')).toMatch(/^[a-z0-9-]+ \((Solid|Regular|Brands)\)$/);
    }
    t.key('Escape'); await a.p;
  });

  test('a hostile catalog row never becomes a tile; terms are matched, never rendered', async () => {
    const hostile = JSON.stringify({ version: '6.5.0', icons: [
      ['"><img src=x id=pwn1>', 's'], ['ok-one', 'x'], ['ok-two', 'sb', '<img src=x id=pwn2> evil'], ['Caps', 'r'], ['a'.repeat(41), 's'], [7, 's'], 'row',
    ] });
    const t = shell({ catalog: hostile });
    const a = await t.open({ value: '' });
    expect(t.vals()).toEqual(['ok-two', 'brands:ok-two']);
    t.type('evil');
    expect(t.vals()).toEqual(['ok-two', 'brands:ok-two']);
    expect(t.d.getElementById('pwn1')).toBe(null);
    expect(t.d.getElementById('pwn2')).toBe(null);
    expect(t.root().innerHTML).not.toMatch(/<img/);
    t.key('Escape'); await a.p;
  });

  test('draws a first chunk only; a scroll near the end draws more', async () => {
    const t = shell();
    const a = await t.open({ value: '' });
    const first = t.tiles().length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(200);
    t.root().querySelector('.yip-grid').dispatchEvent(new t.w.Event('scroll'));
    expect(t.tiles().length).toBe(first * 2);
    t.key('Escape'); await a.p;
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('from a same-origin iframe', () => {
  test('drawn in the top document, resolves into the frame, focus back to the frame\'s button', async () => {
    const t = shell();
    const f = t.d.getElementById('pane');
    const fw = f.contentWindow, fd = f.contentDocument;
    fd.body.innerHTML = '<button id="pick">Choose…</button>';
    const btn = fd.getElementById('pick');
    btn.focus();
    expect(fw.top).toBe(t.w);
    let got;
    fw.eval('window.__go = (b) => window.top.ycIconPicker.open({ value: "star", from: b })');
    const p = fw.__go(btn).then((v) => { got = v; });
    await flush();
    expect(t.d.getElementById('ycIconPicker').hidden).toBe(false);
    expect(fd.getElementById('ycIconPicker')).toBe(null);             // never boxed inside the frame
    t.type('github');
    t.tiles()[0].click();
    await p;
    expect(got).toBe('brands:github');
    expect(fd.activeElement).toBe(btn);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('Settings → My Custom Tab', () => {
  function settings({ tab = { src: '/reports.html', title: 'Reports', icon: 'bug', loadFunc: '' } } = {}) {
    const t = shell();
    const posts = [];
    t.w.firmData = { currentUser: { user: 7, roles: 'staff', user_custom_tab: tab } };
    t.w.user = t.w.firmData.currentUser;
    t.w.apiSend = async (url, method, body) => {
      if (url === '/api/auth/update-custom-tab') {
        posts.push(JSON.parse(JSON.stringify(body)));
        return { status: 'success', user_custom_tab: { ...body, loadFunc: '' } };
      }
      if (url.startsWith('/api/reports')) return { reports: [] };
      return { status: 'success', settings: [], items: [], types: [], calendars: [], signatures: [] };
    };
    t.w.applyCustomTab = () => {};
    const f = t.d.getElementById('pane');
    const html = SETTINGS_HTML.replace(/<script src=[^>]*><\/script>/g, '').replace(/<link [^>]*>/g, '');
    const fd = f.contentDocument;
    f.contentWindow.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };   // jsdom has no CSS.escape
    fd.open(); fd.write(html); fd.close();
    return { ...t, fw: f.contentWindow, fd, posts };
  }

  test('Choose… opens the top picker on the saved icon; the choice previews with its family; Save posts it', async () => {
    const t = settings();
    await flush(30);
    const $ = (id) => t.fd.getElementById(id);
    expect($('ctabIcons')).toBe(null);                                 // the old curated grid is gone
    expect($('ctabIconText')).toBe(null);                              // and the free-text box
    expect(t.fw.CTAB_ICONS).toBe(undefined);
    expect($('ctabIconPrev').className).toBe('fa-solid fa-bug');
    expect($('ctabIconName').textContent).toBe('bug · Solid');
    $('ctabIconPick').click();
    await flush();
    expect(t.P.isOpen()).toBe(true);
    expect(t.root().querySelector('.is-current').getAttribute('data-v')).toBe('bug');
    t.type('house');
    t.tiles().find((b) => b.getAttribute('data-v') === 'house').click();
    await flush();
    expect($('ctabIconPrev').className).toBe('fa-solid fa-house');
    expect($('ctabIconName').textContent).toBe('house · Solid');
    expect($('ctabPreview').querySelector('i').className).toBe('fa-solid fa-house');
    $('ctabSave').click();
    await flush();
    expect(t.posts).toEqual([{ title: 'Reports', icon: 'house', src: '/reports.html' }]);
    // a brand, and a cancel that keeps it
    $('ctabIconPick').click();
    await flush();
    t.type('github');
    t.tiles()[0].click();
    await flush();
    expect($('ctabPreview').querySelector('i').className).toBe('fa-brands fa-github');
    $('ctabIconPick').click();
    await flush();
    t.key('Escape');
    await flush();
    expect($('ctabIconName').textContent).toBe('github · Brands');
    expect(t.fd.activeElement).toBe($('ctabIconPick'));
    $('ctabSave').click();
    await flush();
    expect(t.posts[1].icon).toBe('brands:github');
  });
});
