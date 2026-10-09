/**
 * Mailbox colours — public/js/mailboxColor.js (mailbox-system arc, slice S2).
 * The one module both the server (mailboxService: validation + the random
 * default on create) and the panes (comms.html, mailboxAdmin.html) use.
 *
 * What this pins (each mutation-checked — break it, watch a test fail):
 *   - SURFACES restates theme.css's stock surfaces exactly (a theme retune
 *     that is not mirrored here fails this file, not a user's eyes).
 *   - legible() ALWAYS clears 3:1 on every surface of its theme, for any
 *     input colour (4096-colour sweep), and returns the stored value
 *     unchanged when it already clears — the pick is never second-guessed.
 *   - a shade keeps its hue: the admin's "green" is still green when lifted.
 *   - every PALETTE entry is drawn exactly as stored on the light theme.
 *   - pick(): an unused palette colour first, custom colours ignored.
 *   - the migration's backfill literals are PALETTE, in order.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const C = require('../public/js/mailboxColor');

const ROOT = path.join(__dirname, '..');
const THEME = fs.readFileSync(path.join(ROOT, 'public/theme.css'), 'utf8');

/** The declarations of one top-level theme.css block (`:root {` / `html[data-theme="dark"] {`). */
function block(open) {
  const at = THEME.indexOf(open);
  if (at < 0) throw new Error(`theme.css: no ${open}`);
  let depth = 0;
  for (let i = at + open.length - 1; i < THEME.length; i++) {
    if (THEME[i] === '{') depth++;
    else if (THEME[i] === '}' && --depth === 0) return THEME.slice(at, i + 1);
  }
  throw new Error(`theme.css: unterminated ${open}`);
}
const tokenOf = (css, name) => {
  const m = new RegExp(`\\n\\s*${name.replace(/-/g, '\\-')}:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`theme.css: no ${name}`);
  return m[1].trim().toLowerCase();
};

function hue(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  if (!d) return null;
  let h;
  if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}
const hueGap = (a, b) => { const x = Math.abs(a - b) % 360; return Math.min(x, 360 - x); };

describe('SURFACES mirror theme.css', () => {
  test.each([
    ['light', ':root {'],
    ['dark', 'html[data-theme="dark"] {'],
  ])('%s', (theme, open) => {
    const css = block(open);
    const s = C.SURFACES[theme];
    // dark restates every surface; light holds them in :root
    expect(tokenOf(css, '--surface')).toBe(s.surface);
    expect(tokenOf(css, '--page-bg')).toBe(s.page);
    expect(tokenOf(css, '--surface-2')).toBe(s.surface2);
    expect(tokenOf(css, '--hover')).toBe(s.hover);
    const soft = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(tokenOf(css, '--accent-soft'));
    expect(soft && Number(soft[4])).toBe(s.accentAlpha);
    // …and the list legible() measures against is exactly these, plus the
    // selected row (accent-soft composited over surface and page), computed
    // here from theme.css independently of the module
    const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const over = (base) => '#' + rgbOf(base).map((b, i) => Math.round(Number(soft[i + 1]) * Number(soft[4]) + b * (1 - Number(soft[4])))
      .toString(16).padStart(2, '0')).join('');
    const tok = (n) => tokenOf(css, n);
    expect(C.surfacesOf(theme)).toEqual([tok('--surface'), tok('--page-bg'), tok('--surface-2'), tok('--hover'), over(tok('--surface')), over(tok('--page-bg'))]);
  });
});

describe('normalize', () => {
  test.each([
    ['#2F6FD1', '#2f6fd1'], ['  #abc ', '#aabbcc'], ['#000000', '#000000'],
    ['2f6fd1', null], ['#12345', null], ['#1234567', null], ['#ggg000', null], ['red', null],
    ['', null], [null, null], [undefined, null], [0x2f6fd1, null], [{}, null],
  ])('%p → %p', (v, out) => expect(C.normalize(v)).toBe(out));
});

describe('legible: 3:1 on every surface, nearest to the pick', () => {
  const sweep = [];
  for (let r = 0; r < 16; r++) for (let g = 0; g < 16; g++) for (let b = 0; b < 16; b++) {
    sweep.push('#' + [r, g, b].map((x) => (x * 17).toString(16).padStart(2, '0')).join(''));
  }

  test.each(['light', 'dark'])('%s: every one of 4096 colours comes back clearing 3:1 on every surface', (theme) => {
    const surf = C.surfacesOf(theme);
    const fails = [];
    for (const c of sweep) {
      const out = C.legible(c, theme);
      if (!/^#[0-9a-f]{6}$/.test(out) || surf.some((s) => C.contrast(out, s) < C.MIN_CONTRAST)) fails.push([c, out]);
    }
    expect(fails).toEqual([]);
  });

  test.each(['light', 'dark'])('%s: a colour that already clears is returned untouched', (theme) => {
    const surf = C.surfacesOf(theme);
    let kept = 0;
    for (const c of sweep) {
      if (surf.every((s) => C.contrast(c, s) >= C.MIN_CONTRAST)) {
        expect(C.legible(c, theme)).toBe(c);
        kept++;
      }
    }
    expect(kept).toBeGreaterThan(500); // the sweep really exercised this branch
  });

  test('a shade keeps its hue and moves the right way (darker on light, lighter on dark)', () => {
    for (const c of ['#fff3bf', '#ffff00', '#00ff00', '#a5d8ff', '#ffc9c9']) {
      const d = C.legible(c, 'light');
      expect(d).not.toBe(c);
      expect(C.luminance(d)).toBeLessThan(C.luminance(c));
      expect(hueGap(hue(d), hue(c))).toBeLessThan(6);
    }
    for (const c of ['#000080', '#1b4332', '#4a0e0e', '#2f6fd1']) {
      const l = C.legible(c, 'dark');
      expect(l).not.toBe(c);
      expect(C.luminance(l)).toBeGreaterThan(C.luminance(c));
      expect(hueGap(hue(l), hue(c))).toBeLessThan(6);
    }
  });

  test('…and only just far enough: one notch less fails', () => {
    // pale yellow on light: the result clears; the same hue a little lighter does not
    const out = C.legible('#fff3bf', 'light');
    const lum = C.luminance(out);
    const bound = Math.min(...C.surfacesOf('light').map((s) => (C.luminance(s) + 0.05) / C.MIN_CONTRAST - 0.05));
    expect(lum).toBeLessThanOrEqual(bound);
    expect(lum).toBeGreaterThan(bound - 0.01);
  });

  test('variants(): both themes, or null for no colour; legible() refuses junk', () => {
    expect(C.variants('#2F6FD1')).toEqual({ light: '#2f6fd1', dark: C.legible('#2f6fd1', 'dark') });
    expect(C.variants(null)).toBeNull();
    expect(C.variants('url(x)')).toBeNull();
    expect(C.legible('#2f6fd1', 'sepia')).toBeNull();
  });
});

describe('PALETTE (the random defaults)', () => {
  test('ten distinct normalized colours, each drawn as stored on the light theme', () => {
    expect(C.PALETTE).toHaveLength(10);
    expect(new Set(C.PALETTE).size).toBe(10);
    for (const c of C.PALETTE) {
      expect(C.normalize(c)).toBe(c);
      expect(C.legible(c, 'light')).toBe(c);
    }
    // distinct hues, not ten shades of blue
    const hues = C.PALETTE.map(hue);
    for (let i = 0; i < hues.length; i++) for (let j = i + 1; j < hues.length; j++) expect(hueGap(hues[i], hues[j])).toBeGreaterThan(8);
  });

  test('pick(): an unused colour first; least-used once all are taken; custom colours do not count', () => {
    const used = C.PALETTE.slice(0, 9);
    for (const r of [0, 0.5, 0.999]) expect(C.pick(used, () => r)).toBe(C.PALETTE[9]);
    expect(C.pick([...C.PALETTE, ...C.PALETTE.slice(1)], () => 0)).toBe(C.PALETTE[0]);
    expect(C.pick(['#123456', '#ABCDEF', 'junk'], () => 0)).toBe(C.PALETTE[0]);
    expect(C.pick(['#2F6FD1'], () => 0)).toBe(C.PALETTE[1]); // case-blind
    const seen = new Set();
    for (let i = 0; i < 10; i++) seen.add(C.pick([], () => i / 10));
    expect(seen.size).toBe(10);
    expect(C.PALETTE).toContain(C.pick([]));
  });

  test('the migration backfills from PALETTE, in order', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'ref/migrations/2026-10-09_mailbox_s2.sql'), 'utf8');
    const m = /SET color = ELT\(MOD\(id - 1, (\d+)\) \+ 1,([^)]*)\)/.exec(sql);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBe(C.PALETTE.length);
    expect(m[2].match(/#[0-9a-f]{6}/g)).toEqual([...C.PALETTE]);
  });
});
