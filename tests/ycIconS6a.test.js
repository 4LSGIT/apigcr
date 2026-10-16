// tests/ycIconS6a.test.js
//
/**
 * ui-custom S6a — the stored icon value grammar, its client helper and the
 * catalog.
 *
 *   1. The grammar ^(?:(?:solid|regular|brands):)?[a-z0-9-]{1,40}$, ONE
 *      definition in three copies: public/js/ycIcon.js (the client helper),
 *      lib/uiConfigShape.js ICON_RE and the launcher's own copy in index.html
 *      (the fourth, routes/auth.customTab.js, left with that route in
 *      ui-custom S5e) — pinned equal; accepts bare / solid:
 *      / regular: / brands:, refuses junk; linear on hostile input (timed).
 *   2. ycIcon: cls() maps every form to its family + name and anything else to
 *      fa-solid fa-circle-question; parse / value / same.
 *   3. The firm differential: the validator as it was (the same file with the
 *      pre-S6a ICON_RE put back) against today's, over seeded random firm and
 *      user documents. Bare-slug documents validate byte-identically; a junk
 *      icon differs only in the regex quoted in its message; a family-prefixed
 *      icon is the one intended change (refused before, accepted now, stored
 *      verbatim).
 *   4. POST /api/auth/update-custom-tab, the custom tab's route, is gone
 *      (ui-custom S5e): 404 from the auth.* routers, no route file names it.
 *   5. The catalog: scripts/buildFaIconCatalog.js build() over synthetic
 *      metadata (free styles only, the name grammar enforced, terms + alias
 *      names, deterministic); the committed public/js/faIcons-<v>.json is
 *      well-formed, names every icon the grammar can store, matches the
 *      picker's CATALOG_URL and the FA version index.html links.
 *
 * Mutation-checked (see the S6a worker report).
 *
 * Run:  npx jest tests/ycIconS6a.test.js
 */

'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = global.__s6aAuth || { type: 'jwt', userId: 7, roles: ['staff'] }; next(); }));

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const YI = require('../public/js/ycIcon.js');
const shape = require('../lib/uiConfigShape');
const catalogTool = require('../scripts/buildFaIconCatalog');

const OLD_RE_SRC = '/^[a-z0-9-]{1,40}$/';
const NEW_RE_SRC = '/^(?:(?:solid|regular|brands):)?[a-z0-9-]{1,40}$/';

// ─────────────────────────────────────────────────────────────────────────
describe('the grammar: one definition, three copies', () => {
  test('ycIcon.RE, lib/uiConfigShape ICON_RE and the launcher copy are the same regex', () => {
    expect(String(YI.RE)).toBe(NEW_RE_SRC);
    expect(String(shape.ICON_RE)).toBe(NEW_RE_SRC);
    const shell = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').match(/var ICON_RE = (\/.*?\/[a-z]*);/);
    expect(shell && shell[1]).toBe(NEW_RE_SRC);
  });

  const GOOD = ['star', 'brands:github', 'regular:star', 'solid:star', 'money-check-dollar', '1', 'arrow-up-9-1', 'c', 'a'.repeat(40),
    'brands:' + 'a'.repeat(40), '-', '42-group'];
  const BAD = ['', 'brands:', 'fab:github', 'fa-brands:github', 'light:star', 'sharp:star', 'thin:star', 'duotone:star', 'Brands:github',
    'BRANDS:GITHUB', 'Star', 'star ', ' star', 'a'.repeat(41), 'brands:' + 'a'.repeat(41), 'brands:github:x', 'solid:regular:star',
    ':star', 'brands::github', 'fa-solid fa-star', 'star"', 'star><img', 'brands:git hub', 'regular/star', 'star\n', 'солид:star',
    null, undefined, 7, {}, ['star']];

  test.each(GOOD)('accepts %j (client, server, route)', (v) => {
    expect([YI.valid(v), shape.ICON_RE.test(v)]).toEqual([true, true]);
  });
  test.each(BAD.map((v) => [JSON.stringify(v) || String(v), v]))('refuses %s', (_, v) => {
    expect(YI.valid(v)).toBe(false);
    if (typeof v === 'string') expect(shape.ICON_RE.test(v)).toBe(false);
  });

  test('linear: hostile near-misses up to 2 MB are decided in well under a second, by every copy', () => {
    const n = 1 << 20;
    const cases = ['a'.repeat(n), 'a'.repeat(n) + '!', 'brands:' + 'a'.repeat(n), 'solid:'.repeat(n / 8), 'brands'.repeat(n / 8) + ':x',
      ':'.repeat(n), ('a:'.repeat(n / 2)), 'regular:' + '-'.repeat(n) + 'A', 'b'.repeat(n) + ':star'];
    const t0 = process.hrtime.bigint();
    for (const s of cases) {
      expect(YI.valid(s)).toBe(false);
      expect(shape.ICON_RE.test(s)).toBe(false);
      const r = shape.validate('firm', 'registry_overrides', { items: [{ id: 'firm:x', label: 'X', icon: s, action: { type: 'url', href: '/r', present: 'window' } }] });
      expect(r.ok).toBe(false);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('ycIcon: value → classes', () => {
  test.each([
    ['star', 'fa-solid fa-star'],
    ['solid:star', 'fa-solid fa-star'],
    ['regular:star', 'fa-regular fa-star'],
    ['brands:github', 'fa-brands fa-github'],
    ['1', 'fa-solid fa-1'],
  ])('%s → %s', (v, cls) => {
    expect(YI.cls(v)).toBe(cls);
    expect(YI.cls(v, 'fa-2xl')).toBe(cls + ' fa-2xl');
    expect(YI.cls(v, ' fa-2xl')).toBe(cls + ' fa-2xl');      // the launcher's leading-space form
    expect(YI.cls(v, '')).toBe(cls);
  });

  test.each(['', 'brands:', 'fab:github', 'Star', 'star" onmouseover="x', 'brands:git hub', 'x'.repeat(41), null, undefined, 3, {}])(
    'junk %j → the fallback, never a class built from it', (v) => {
      expect(YI.cls(v)).toBe('fa-solid fa-circle-question');
      expect(YI.cls(v, 'bad')).toBe('fa-solid fa-circle-question bad');
    });

  test('parse / value / same; the api is frozen', () => {
    expect(YI.parse('star')).toEqual({ family: 'solid', name: 'star' });
    expect(YI.parse('brands:github')).toEqual({ family: 'brands', name: 'github' });
    expect(YI.parse('fab:github')).toBe(null);
    expect(YI.value('solid', 'star')).toBe('star');                  // solid is written BARE
    expect(YI.value('regular', 'star')).toBe('regular:star');
    expect(YI.value('brands', 'github')).toBe('brands:github');
    expect(YI.value('light', 'star')).toBe(null);
    expect(YI.value('brands', 'Git Hub')).toBe(null);
    expect(YI.value('solid', 'x'.repeat(41))).toBe(null);
    expect(YI.same('star', 'solid:star')).toBe(true);
    expect(YI.same('star', 'regular:star')).toBe(false);
    expect(YI.same('junk!', 'junk!')).toBe(false);
    expect(YI.FAMILIES).toEqual(['solid', 'regular', 'brands']);
    expect(Object.isFrozen(YI) && Object.isFrozen(YI.FAMILIES)).toBe(true);
  });

  test('every registry icon is a bare slug the grammar accepts (so the launcher renders it exactly as before)', () => {
    const ctx = { window: {} };
    new Function('window', fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8'))(ctx.window);
    const icons = Object.values(ctx.window.FEATURE_REGISTRY).map((it) => it.icon);
    expect(icons.length).toBeGreaterThan(20);
    for (const ic of icons) expect([ic, YI.valid(ic) && !ic.includes(':')]).toEqual([ic, true]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. The differential. "Before" is this very file with the pre-S6a ICON_RE
// put back, compiled as its own module — so the comparison isolates the icon
// grammar: any other effect of the change (normalising a value, a reworded
// message, a field dropped) shows up as a difference.
const SHAPE_PATH = path.join(ROOT, 'lib/uiConfigShape.js');
// Compiled in THIS realm (jest's), with jest's require for its dependencies,
// so its plain-object checks see the test's objects as plain.
function compileShape(src) {
  const mod = { exports: {} };
  const req = (id) => require(id.startsWith('.') ? path.resolve(path.dirname(SHAPE_PATH), id) : id);
  new Function('require', 'module', 'exports', '__filename', '__dirname', src)(req, mod, mod.exports, SHAPE_PATH, path.dirname(SHAPE_PATH));
  return mod.exports;
}
const SHAPE_SRC = fs.readFileSync(SHAPE_PATH, 'utf8');
const DECL_RE = /^const ICON_RE = \/.*\/;/m;     // whatever the file declares today

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gen(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const slug = (max = 40) => { const n = 1 + Math.floor(r() * max); let s = ''; for (let i = 0; i < n; i++) s += pick('abcdefghijklmnopqrstuvwxyz0123456789-'); return s; };
  return {
    pick, slug,
    bare: () => slug(),                                      // a valid bare slug (1–40)
    junk: () => pick(['', 'Star', 'fa-x y', 'star"', 'a'.repeat(41), slug(40) + slug(5), 'x:y', 'fab:' + slug(), 'brands:', ' ' + slug(), slug() + '!', 7, null]),
    fam: () => pick(['solid', 'regular', 'brands']) + ':' + slug(),
  };
}
function firmDoc(g, r, iconOf) {
  const n = Math.floor(r() * 6);
  const items = [];
  for (let i = 0; i < n; i++) {
    const kind = g.pick(['url', 'tool', 'view', 'url']);
    const action = kind === 'url' ? { type: 'url', href: g.pick(['/reports', 'https://x.example.com/a', '/tool/x', 'http://no']), present: 'window' }
      : { type: kind, key: kind === 'tool' ? g.slug(10) : 'v_' + g.slug(8).replace(/-/g, '_'), present: 'modal', ...(r() < 0.3 ? { size: g.pick(['compact', 'large', 'huge']) } : {}) };
    items.push({ id: r() < 0.05 ? 'firm:Bad' : 'firm:' + g.slug(12), label: r() < 0.05 ? '' : 'Item ' + g.slug(8), icon: iconOf(), action });
  }
  const doc = { hidden: r() < 0.5 ? ['tasks', 'bills'].slice(0, Math.floor(r() * 3)) : [], locked: [], renames: r() < 0.3 ? { cases: { label: 'Matters' } } : {}, items };
  if (r() < 0.1) doc.extra = 1;
  return doc;
}
function userItemsDoc(g, r, iconOf) {
  const items = [];
  const n = Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const drawer = r() < 0.25;
    items.push({ id: 'user:' + g.slug(10), label: 'Mine ' + i, icon: iconOf(),
      action: drawer ? { type: 'drawer', items: ['tasks', 'firm:a'] } : { type: 'view', key: 'lead_followups', present: 'modal' } });
  }
  return { items };
}

describe('the firm differential: the validator before S6a vs today', () => {
  let OLD;
  beforeAll(() => {
    expect((SHAPE_SRC.match(new RegExp(DECL_RE.source, 'gm')) || []).length).toBe(1);   // anchored: exactly one declaration
    const src = SHAPE_SRC.replace(DECL_RE, `const ICON_RE = ${OLD_RE_SRC};`);
    expect(src.includes(`const ICON_RE = ${OLD_RE_SRC};`)).toBe(true);       // the edit is in the source before we use it
    OLD = compileShape(src);
  });
  const NEW = shape;
  const run = (S, scope, key, doc) => JSON.stringify(S.validate(scope, key, JSON.parse(JSON.stringify(doc))));
  const oldMsg = (s) => s.split(OLD_RE_SRC).join(NEW_RE_SRC);

  test('bare-slug documents (firm registry_overrides and user items, 6,000 seeded) validate byte-identically', () => {
    expect(String(OLD.ICON_RE)).toBe(OLD_RE_SRC);
    const r = rng(0x5a6a), g = gen(r);
    let n = 0, okCount = 0;
    for (let i = 0; i < 4000; i++) {
      const doc = firmDoc(g, r, g.bare);
      const a = run(OLD, 'firm', 'registry_overrides', doc), b = run(NEW, 'firm', 'registry_overrides', doc);
      if (a !== b) throw new Error('differs: ' + JSON.stringify(doc) + '\n' + a + '\n' + b);
      if (JSON.parse(b).ok) okCount++;
      n++;
    }
    for (let i = 0; i < 2000; i++) {
      const doc = userItemsDoc(g, r, g.bare);
      expect(run(NEW, 'user', 'items', doc)).toBe(run(OLD, 'user', 'items', doc));
      n++;
    }
    expect(n).toBe(6000);
    expect(okCount).toBeGreaterThan(400);            // the fuzz reaches valid documents, not only refusals
    expect(okCount).toBeLessThan(4000);
  });

  test('a junk icon: refused by both; the message differs only in the regex it quotes', () => {
    const r = rng(0xbad), g = gen(r);
    let refused = 0;
    for (let i = 0; i < 1500; i++) {
      const doc = firmDoc(g, r, () => (r() < 0.5 ? g.junk() : g.bare()));
      const a = run(OLD, 'firm', 'registry_overrides', doc), b = run(NEW, 'firm', 'registry_overrides', doc);
      expect(b).toBe(oldMsg(a));
      if (a.includes('icon must match')) refused++;
    }
    expect(refused).toBeGreaterThan(300);
  });

  test('a family-prefixed icon is the one intended change: refused before, accepted now and stored verbatim', () => {
    const r = rng(0xfa), g = gen(r);
    let flipped = 0;
    for (let i = 0; i < 1500; i++) {
      const doc = firmDoc(g, r, () => (r() < 0.5 ? g.fam() : g.bare()));
      const a = JSON.parse(run(OLD, 'firm', 'registry_overrides', doc)), b = JSON.parse(run(NEW, 'firm', 'registry_overrides', doc));
      const famIcons = doc.items.filter((it) => /^(solid|regular|brands):/.test(it.icon) && it.icon.length <= 48 && YI.valid(it.icon)).length;
      if (!famIcons) { expect(JSON.stringify(b)).toBe(oldMsg(JSON.stringify(a))); continue; }
      // the old refusals minus exactly the family-prefixed icons' own errors
      const famErr = (e) => /icon must match/.test(e) && doc.items.some((it, k) => YI.valid(it.icon) && it.icon.includes(':') && e.startsWith(`items[${k}]:`));
      expect(b.errors).toEqual(a.errors.filter((e) => !famErr(e)).map(oldMsg));
      if (b.ok) {
        flipped++;
        expect(b.value.items.map((it) => it.icon)).toEqual(doc.items.map((it) => it.icon));
      }
    }
    expect(flipped).toBeGreaterThan(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('POST /api/auth/update-custom-tab is gone (ui-custom S5e retired the custom tab)', () => {
  // the server mounts every routes/*.js (server.js's loader); here: every auth.* router, the family the route lived in
  let server, base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    for (const f of fs.readdirSync(path.join(ROOT, 'routes')).filter((n) => /^auth\..*\.js$/.test(n))) app.use(require(path.join(ROOT, 'routes', f)));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  test('404 for a POST (with or without a token) — and no route file names the path', async () => {
    for (const headers of [{}, { authorization: 'Bearer x.y.z' }]) {
      const r = await fetch(base + '/api/auth/update-custom-tab', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ clear: true }) });
      expect(r.status).toBe(404);
    }
    expect(fs.existsSync(path.join(ROOT, 'routes/auth.customTab.js'))).toBe(false);
    for (const f of fs.readdirSync(path.join(ROOT, 'routes')).filter((n) => n.endsWith('.js'))) {
      expect([f, /update-custom-tab|user_custom_tab\s*=\s*\?/.test(fs.readFileSync(path.join(ROOT, 'routes', f), 'utf8'))]).toEqual([f, false]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the catalog', () => {
  const META = {
    star: { label: 'Star', search: { terms: ['Favorite', 'rating', 'star'] }, familyStylesByLicense: { free: [{ family: 'classic', style: 'regular' }, { family: 'classic', style: 'solid' }], pro: [] } },
    github: { search: { terms: ['octocat'] }, familyStylesByLicense: { free: [{ family: 'classic', style: 'brands' }] } },
    house: { search: { terms: ['home  sweet'] }, aliases: { names: ['home', 'home-alt'] }, familyStylesByLicense: { free: [{ family: 'classic', style: 'solid' }] } },
    'pro-only': { familyStylesByLicense: { free: [], pro: [{ family: 'classic', style: 'solid' }] } },
    sharpish: { familyStylesByLicense: { free: [{ family: 'sharp', style: 'solid' }, { family: 'classic', style: 'light' }] } },
    '0': { search: { terms: [] }, familyStylesByLicense: { free: [{ family: 'classic', style: 'solid' }] } },
  };

  test('build(): free classic solid / regular / brands only; terms + alias names, lower case, de-duplicated, name left out; sorted', () => {
    const { catalog, skipped } = catalogTool.build(META, '6.5.0');
    expect(catalog.version).toBe('6.5.0');
    expect(catalog.icons).toEqual([['0', 's'], ['github', 'b', 'octocat'], ['house', 's', 'home sweet home home-alt'], ['star', 'sr', 'favorite rating']]);
    expect(skipped).toBe(2);
    expect(catalogTool.serialize(catalog)).toBe(catalogTool.serialize(catalogTool.build(JSON.parse(JSON.stringify(META)), '6.5.0').catalog));
  });

  test('build() FAILS on a free name the grammar cannot store, and on a bad version', () => {
    expect(() => catalogTool.build({ 'Bad Name': META.github }, '6.5.0')).toThrow(/does not match/);
    expect(() => catalogTool.build({ ['x'.repeat(41)]: META.github }, '6.5.0')).toThrow(/does not match/);
    expect(() => catalogTool.build(META, 'latest')).toThrow(/bad version/);
    expect(() => catalogTool.build({ 'pro-only': META['pro-only'] }, '6.5.0')).toThrow(/no free icons/);
  });

  const pickerSrc = fs.readFileSync(path.join(ROOT, 'public/js/ycIconPicker.js'), 'utf8');
  const url = pickerSrc.match(/var CATALOG_URL = '([^']+)';/)[1];
  const file = path.join(ROOT, 'public', url);
  const text = fs.readFileSync(file, 'utf8');
  const cat = JSON.parse(text);

  test('the committed catalog is the one the picker loads, for the FA version the shell links', () => {
    expect(url).toBe(`/js/faIcons-${cat.version}.json`);
    const shell = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    expect(shell).toContain(`/ajax/libs/font-awesome/${cat.version}/css/all.min.css`);
    for (const pane of ['public/settings.html', 'public/caseconfig/firm.html']) {
      expect(fs.readFileSync(path.join(ROOT, pane), 'utf8')).toContain(`/ajax/libs/font-awesome/${cat.version}/css/all.min.css`);
    }
    expect(cat.generated_by).toBe('scripts/buildFaIconCatalog.js');
    expect(text).toBe(catalogTool.serialize(cat));              // exactly the generator's layout
  });

  test('well-formed: sorted, unique names the grammar stores in every family listed; lean (no SVG); about 2,000 tiles', () => {
    const names = cat.icons.map((i) => i[0]);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    const n = { s: 0, r: 0, b: 0 };
    for (const row of cat.icons) {
      expect(row.length === 2 || (row.length === 3 && typeof row[2] === 'string' && row[2].length > 0)).toBe(true);
      expect(row[1]).toMatch(/^(s?r?b?)$/);
      expect(row[1].length).toBeGreaterThan(0);
      for (const c of row[1]) {
        n[c]++;
        expect(YI.valid(YI.value({ s: 'solid', r: 'regular', b: 'brands' }[c], row[0]))).toBe(true);
      }
    }
    expect(n).toEqual({ s: 1390, r: 163, b: 481 });
    expect(text).not.toMatch(/<svg|"path"|viewBox/);
    expect(Buffer.byteLength(text)).toBeLessThan(160 * 1024);
    // the regular set is a subset of solid's names; github is a brand; house finds "home"
    for (const row of cat.icons) if (row[1].includes('r')) expect(row[1]).toContain('s');
    expect(cat.icons.find((i) => i[0] === 'github')[1]).toBe('b');
    expect(cat.icons.find((i) => i[0] === 'house')[2]).toMatch(/\bhome\b/);
  });

  test('every registry icon is in the catalog as a solid icon (the picker can highlight it)', () => {
    const ctx = { window: {} };
    new Function('window', fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8'))(ctx.window);
    const solid = new Set(cat.icons.filter((i) => i[1].includes('s')).map((i) => i[0]));
    const missing = Object.values(ctx.window.FEATURE_REGISTRY).map((it) => it.icon).filter((ic) => !solid.has(ic));
    expect(missing).toEqual([]);
  });
});
