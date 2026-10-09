/* public/js/mailboxColor.js — mailbox colours (mailbox-system arc, slice S2)
 *
 * Every mailbox carries ONE stored colour (`mailboxes.color`, '#rrggbb', NULL =
 * none chosen) so a glance at the comms hub tells boxes apart. It is assigned
 * when the box is added — the admin's pick, or a random default from PALETTE
 * — and editable afterwards; everyone sees the same colour for the same box.
 *
 * Shared by the browser (comms.html, mailboxAdmin.html) and the server
 * (services/mailboxService.js: validation + the random default on create), the
 * lib/internal_functions/reports.js → public/js/reportCharts.js precedent.
 * Pure: no DOM, no globals beyond the export.
 *
 * ── LEGIBILITY ──────────────────────────────────────────────────────────────
 * A custom pick can be anything (pale yellow, navy). The colour is only ever
 * drawn as a non-text graphic — a dot, a row stripe, a chip border — beside
 * the printed address, so the bar is WCAG SC 1.4.11's 3:1 against every
 * surface it sits on. variants() returns one value per theme: the stored
 * colour unchanged where it already clears 3:1, otherwise the same hue and
 * saturation with HSL lightness moved just far enough (darker for the light
 * theme, lighter for the dark one). The stored value is never rewritten — a
 * theme retune only changes what is drawn. SURFACES restates theme.css's
 * stock values; tests/mailboxS2.color.test.js fails if they drift. (A user's
 * own yc-theme-vars surface overrides are not measured — their choice.)
 */
(function (root) {
  'use strict';

  // Random defaults: ten hues spaced around the wheel, ordered so the first
  // boxes get the most distinct ones. Each already clears 3:1 on every LIGHT
  // surface (so it is drawn exactly as stored there); the dark theme lifts it.
  var PALETTE = Object.freeze([
    '#2f6fd1', // blue
    '#d9480f', // orange
    '#2b8a3e', // green
    '#9c36b5', // purple
    '#0b7f86', // teal
    '#c2255c', // pink
    '#9a6b00', // amber
    '#5f6ad1', // indigo
    '#c92a2a', // red
    '#5c940d', // olive
  ]);

  // The surfaces a mailbox colour is drawn on (theme.css stock values):
  // --surface, --page-bg, --surface-2, --hover, and the selected row's
  // --accent-soft composited over --surface and --page-bg.
  var ACCENT = [7, 173, 239];
  var SURFACES = Object.freeze({
    light: Object.freeze({ surface: '#ffffff', page: '#f6f7f9', surface2: '#f1f3f6', hover: '#e8eaed', accentAlpha: 0.12 }),
    dark: Object.freeze({ surface: '#1a1e2a', page: '#131722', surface2: '#202634', hover: '#2a2f3d', accentAlpha: 0.22 }),
  });
  var MIN_CONTRAST = 3;

  var HEX6 = /^#[0-9a-f]{6}$/;
  var HEX3 = /^#[0-9a-f]{3}$/;

  /** '#RGB' / '#RRGGBB' (any case, surrounding space) → '#rrggbb'; anything else → null. */
  function normalize(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim().toLowerCase();
    if (HEX3.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return HEX6.test(s) ? s : null;
  }

  function rgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  function toHex(c) {
    return '#' + c.map(function (x) {
      var n = Math.max(0, Math.min(255, Math.round(x)));
      return (n < 16 ? '0' : '') + n.toString(16);
    }).join('');
  }

  /** WCAG relative luminance of '#rrggbb'. */
  function luminance(hex) {
    var c = rgb(hex).map(function (x) {
      var s = x / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  /** WCAG contrast ratio of two '#rrggbb' colours (≥ 1). */
  function contrast(a, b) {
    var x = luminance(a);
    var y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  function blend(over, base, alpha) {
    var o = over;
    var b = rgb(base);
    return toHex([0, 1, 2].map(function (i) { return o[i] * alpha + b[i] * (1 - alpha); }));
  }

  /** Every surface of one theme as '#rrggbb' (accent-soft composited). */
  function surfacesOf(theme) {
    var s = SURFACES[theme];
    return [s.surface, s.page, s.surface2, s.hover,
      blend(ACCENT, s.surface, s.accentAlpha), blend(ACCENT, s.page, s.accentAlpha)];
  }

  function hsl(hex) {
    var c = rgb(hex).map(function (x) { return x / 255; });
    var max = Math.max(c[0], c[1], c[2]);
    var min = Math.min(c[0], c[1], c[2]);
    var l = (max + min) / 2;
    var h = 0;
    var s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === c[0]) h = ((c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0)) / 6;
      else if (max === c[1]) h = ((c[2] - c[0]) / d + 2) / 6;
      else h = ((c[0] - c[1]) / d + 4) / 6;
    }
    return [h, s, l];
  }
  function fromHsl(h, s, l) {
    if (s === 0) return toHex([l * 255, l * 255, l * 255]);
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    var f = function (t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return toHex([f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]);
  }

  // Surface luminances per theme, computed once (constants, not mailbox data).
  var LUMS = {};
  function surfaceLums(theme) {
    if (!LUMS[theme]) LUMS[theme] = surfacesOf(theme).map(luminance);
    return LUMS[theme];
  }

  /** Does '#rrggbb' clear MIN_CONTRAST against every surface of the theme? */
  function clears(hex, theme) {
    var l = luminance(hex);
    var lums = surfaceLums(theme);
    for (var i = 0; i < lums.length; i++) {
      var ratio = (Math.max(l, lums[i]) + 0.05) / (Math.min(l, lums[i]) + 0.05);
      if (ratio < MIN_CONTRAST) return false;
    }
    return true;
  }

  /**
   * The colour as drawn on one theme: unchanged when it clears 3:1 on every
   * surface of that theme, else the nearest lightness (same hue/saturation)
   * that does — darker on 'light', lighter on 'dark'. Checked on the final
   * rounded hex, so the result always clears. Non-colour input → null.
   */
  function legible(color, theme) {
    var hex = normalize(color);
    if (!hex || !SURFACES[theme]) return null;
    if (clears(hex, theme)) return hex;
    var hs = hsl(hex);
    // Bisect on lightness between the stored value and the extreme that is
    // sure to pass (black on light surfaces, white on dark ones); keep the
    // passing end, so what comes back is the passing value nearest the pick.
    var good = theme === 'light' ? 0 : 1;
    var bad = hs[2];
    for (var i = 0; i < 24; i++) {
      var mid = (good + bad) / 2;
      if (clears(fromHsl(hs[0], hs[1], mid), theme)) good = mid; else bad = mid;
    }
    var out = fromHsl(hs[0], hs[1], good);
    return clears(out, theme) ? out : (theme === 'light' ? '#000000' : '#ffffff');
  }

  /** {light, dark} drawing values for a stored colour; null when there is none. */
  function variants(color) {
    var hex = normalize(color);
    if (!hex) return null;
    return { light: legible(hex, 'light'), dark: legible(hex, 'dark') };
  }

  /**
   * The random default for a new mailbox: a PALETTE colour no box uses yet,
   * else one of the least-used (custom colours outside the palette do not
   * count). `rand` is injectable for tests (Math.random by default).
   */
  function pick(used, rand) {
    var r = typeof rand === 'function' ? rand : Math.random;
    var counts = {};
    PALETTE.forEach(function (c) { counts[c] = 0; });
    (Array.isArray(used) ? used : []).forEach(function (u) {
      var c = normalize(u);
      if (c && Object.prototype.hasOwnProperty.call(counts, c)) counts[c] += 1;
    });
    var least = Math.min.apply(null, PALETTE.map(function (c) { return counts[c]; }));
    var pool = PALETTE.filter(function (c) { return counts[c] === least; });
    var i = Math.floor(r() * pool.length);
    return pool[Math.max(0, Math.min(pool.length - 1, i))];
  }

  root.YCMailboxColor = {
    PALETTE: PALETTE,
    SURFACES: SURFACES,
    MIN_CONTRAST: MIN_CONTRAST,
    normalize: normalize,
    luminance: luminance,
    contrast: contrast,
    surfacesOf: surfacesOf,
    legible: legible,
    variants: variants,
    pick: pick,
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* Node/CommonJS export (server validation + the random default; unit tests). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).YCMailboxColor;
}
