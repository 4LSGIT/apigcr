#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   checkThemePresets — measures every contrast pair in public/themeCustom.html
   against theme.css, at stock and under each preset, in both modes.

   The Advanced tab lets a user build a failing palette on purpose; that is
   their call, and the badges tell them. The PRESETS are a different promise:
   they are the safe path, the default tab, and the thing most users will ever
   click. This script is what makes "pre-measured" a fact rather than a claim.

   Run it after touching PRESETS or PAIRS in themeCustom.html, and after any
   colour change in theme.css:

     node scripts/checkThemePresets.js

   Exits non-zero if any pair falls below the AA floor of 4.5.
   ═══════════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUB, 'theme.css'), 'utf8');
const page = fs.readFileSync(path.join(PUB, 'themeCustom.html'), 'utf8');

/* ── stock tokens out of theme.css ──────────────────────────────────────
   The browser gets these through the CSSOM. Here we cut the two token blocks
   out by hand, which means being exact about the dark one: theme.css opens
   FOUR html[data-theme="dark"] blocks and only the bare selector is the token
   block. Anchoring the selector to a whole line is what keeps the control
   baseline and the two SweetAlert blocks out. */
function block(re) {
  const m = re.exec(css);
  if (!m) throw new Error('block not found: ' + re);
  const start = m.index + m[0].length;
  return css.slice(start, css.indexOf('\n}', start));
}
function tokens(text) {
  const out = {};
  // Comments can contain colons and braces; strip them before reading pairs.
  for (const line of text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
    const m = /^\s*(--[\w-]+)\s*:\s*([^;]+);/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
const LIGHT = tokens(block(/^:root\s*\{/m));
const DARK = tokens(block(/^html\[data-theme="dark"\]\s*\{/m));

/* ── PAIRS and PRESETS straight out of the page ─────────────────────────
   Read rather than duplicated: a copy here would drift, and a checker that
   measures different values from the ones that ship is worse than none. */
function lift(name) {
  const m = new RegExp('const ' + name + ' = ([\\[{][\\s\\S]*?\\n[\\]}]);').exec(page);
  if (!m) throw new Error('could not lift ' + name + ' from themeCustom.html');
  return eval('(' + m[1] + ')');
}
const PAIRS = lift('PAIRS');
const PRESETS = lift('PRESETS');

/* ── colour maths (mirrors themeCustom.html) ────────────────────────── */
function parseColor(v) {
  if (!v) return null;
  v = String(v).trim();
  let m = /^#([0-9a-f]+)$/i.exec(v);
  if (m) {
    const h = m[1];
    const ex = c => parseInt(c.length === 1 ? c + c : c, 16);
    if (h.length === 3 || h.length === 4)
      return { r: ex(h[0]), g: ex(h[1]), b: ex(h[2]), a: h.length === 4 ? ex(h[3]) / 255 : 1 };
    if (h.length === 6 || h.length === 8)
      return { r: ex(h.slice(0, 2)), g: ex(h.slice(2, 4)), b: ex(h.slice(4, 6)),
               a: h.length === 8 ? ex(h.slice(6, 8)) / 255 : 1 };
    return null;
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) {
    const p = m[1].split(/[,\/\s]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some(isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}
const over = (fg, bg) => fg.a >= 1 || !bg ? fg : {
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
};
function luminance(c) {
  const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function ratio(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/* ── measure one palette ────────────────────────────────────────────── */
function paletteFor(mode, over_) {
  // Dark inherits every token it does not restate — the mode-independent set.
  const base = mode === 'dark' ? Object.assign({}, LIGHT, DARK) : Object.assign({}, LIGHT);
  return Object.assign(base, over_ || {});
}
function resolve(pal, n, d) {
  const v = pal[n];
  const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(String(v || '').trim());
  return (alias && (d || 0) < 5) ? resolve(pal, alias[1], (d || 0) + 1) : v;
}
function measure(pal, pair) {
  const fg = parseColor(resolve(pal, pair[0]));
  let bg = parseColor(resolve(pal, pair[1]));
  if (!fg || !bg) return null;
  if (bg.a < 1) {
    const base = parseColor(resolve(pal, pair[2] || '--surface'));
    if (!base) return null;
    bg = over(bg, base);
  }
  return ratio(over(fg, bg), bg);
}

/* ── run ────────────────────────────────────────────────────────────── */
const AA = 4.5;
let failed = 0;

function check(label, overrides) {
  for (const mode of ['light', 'dark']) {
    const pal = paletteFor(mode, overrides && overrides[mode]);
    const bad = [];
    let unread = 0;
    for (const p of PAIRS) {
      const r = measure(pal, p);
      if (r === null) { unread++; continue; }
      if (r < AA) bad.push(`${p[0]} on ${p[1]}: ${r.toFixed(2)}`);
    }
    const tag = `${label} / ${mode}`.padEnd(28);
    if (bad.length) {
      failed += bad.length;
      console.log(`FAIL  ${tag} ${bad.length}/${PAIRS.length} below ${AA}`);
      for (const b of bad) console.log(`        ${b}`);
    } else {
      console.log(`ok    ${tag} ${PAIRS.length - unread}/${PAIRS.length} pairs pass`
        + (unread ? ` (${unread} not a colour)` : ''));
    }
  }
}

console.log(`${PAIRS.length} pairs, ${Object.keys(LIGHT).length} tokens\n`);
check('stock', null);
for (const [key, p] of Object.entries(PRESETS)) check(p.label, p);

console.log(failed ? `\n${failed} failing pair(s).` : '\nAll palettes pass AA.');
process.exit(failed ? 1 : 0);
