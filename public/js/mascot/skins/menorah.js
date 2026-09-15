/* public/js/mascot/skins/menorah.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, MENORAH FORM — the seasonal one
 *
 * Hidden from the picker and forced by the SEASONAL table for the eight
 * nights of Hanukkah, one more candle per night: this is the skin the
 * `svg`-as-a-function clause of the contract exists for. The engine hands the
 * merged CFG to svg(), and CFG.SEASONAL_DAY says which night this is (0-based;
 * -1 means "not in the window" — a console summon in July — which renders the
 * full eight, because the portrait should be the finale, not night one).
 *
 * It carries itself accordingly: core states only — no chasing, no climbing,
 * no jetpack — and a walk slowed to a shuffle. A menorah that scampers is a
 * menorah nobody believes. It still walks the ledges, because a desktop pet
 * that only stands there is a wallpaper, and it still says things when poked,
 * because that is the one interaction that is always invited.
 *
 * Brass reads as brass in both themes the way the cats' fur does: literal
 * fills, engine dark-mode filter, no theme tokens in the artwork. The flames
 * are the only thing that must never sit still.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'menorah',
    name: 'Menorah',
    blurb: 'Eight nights of lights. Turns up when it is time.',

    // Taller than it is wide, feet at the base. No ascent in `can`, so
    // FLY_HEAD is the sprite's own height per the contract's convention.
    geom: { W: 34, H: 30, FLY_HEAD: 30 },

    // A stately shuffle. Everything else keeps engine defaults.
    tune: { WALK: 22 },

    // Core states only: it walks, it stands, it falls with dignity when the
    // ground goes away, it can be carried, it can be sent home.
    can: ['walk', 'idle', 'fall', 'land', 'drag', 'leave'],

    acts: [
      ['rest', 30], ['glow', 22], ['flicker', 20], ['drip', 14]
    ],

    // When it notices you, it glows.
    lookAct: 'glow',

    lines: [
      'One more light than last night.',
      'The oil was budgeted for one day. Ask accounting.',
      'Eight nights. No billable hours.',
      'Longest-running miracle of record.',
      'Set right to left. Lit left to right. Always.',
      'The shamash works so the others can shine.',
      'Filed under: lights, festival of.',
      'No wind objections will be sustained.',
      'Latkes are not evidence. Bring them anyway.',
      'I have reviewed the darkness. Overruled.',
      'This window seat is load-bearing tradition.',
      'Do not bill the miracle.',
      'Dreidel outcomes are not legal advice.',
      'Wax on the brief? Frame the brief.',
      'Eight for the nights. One for the work.'
    ],

    words: { idle: 'settle' },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 34×30, feet on the bottom edge. A function of the merged CFG: candle
    // count comes off CFG.SEASONAL_DAY. Holders fill RIGHT to LEFT as the
    // nights advance, the way the candles are set; the shamash stands centre,
    // raised, and is always lit. Flames overflow the top of the viewBox and
    // may — the svg is overflow:visible, same as the cats' z's.
    svg: function (CFG) {
      var night = CFG.SEASONAL_DAY >= 0 ? Math.min(CFG.SEASONAL_DAY + 1, 8) : 8;

      var s = '<svg class="m9-svg" viewBox="0 0 34 30" width="34" height="30"' +
        ' aria-hidden="true" focusable="false"><g class="m9-all">';

      // the glow behind the flame row — an act turns it up
      s += '<ellipse class="m9-halo" cx="17" cy="5" rx="16" ry="7" fill="#FFC94A" opacity="0"/>';

      // arms: four nested arcs meeting the stem, then the stem and the base
      var r;
      for (r = 1; r <= 4; r++) {
        var w = 3.6 * r;
        s += '<path d="M' + (17 - w) + ' 9.5 A ' + w + ' ' + (w * 0.95).toFixed(1) +
          ' 0 0 0 ' + (17 + w) + ' 9.5" fill="none" stroke="#C9A24B" stroke-width="1.7"/>';
      }
      s += '<rect x="16.1" y="5" width="1.8" height="20" rx=".9" fill="#C9A24B"/>' +
        '<path d="M16.1 6 v18" stroke="#E8CE82" stroke-width=".5"/>' +          // stem highlight
        '<rect x="12" y="24.4" width="10" height="1.7" rx=".85" fill="#C9A24B"/>' +
        '<path d="M11.5 30 L22.5 30 L20.2 26 L13.8 26 Z" fill="#C9A24B" stroke="#8A6C2C" stroke-width=".5"/>';

      // nine holders: i = -4..4 across, the centre one raised for the shamash
      var i;
      for (i = -4; i <= 4; i++) {
        var x = 17 + i * 3.6, cy = i === 0 ? 4.6 : 9.5;
        s += '<rect x="' + (x - 1.7).toFixed(1) + '" y="' + cy + '" width="3.4" height="1.6" rx=".5"' +
          ' fill="#C9A24B" stroke="#8A6C2C" stroke-width=".4"/>';
      }

      // candles + flames: the shamash (centre), then `night` of the eight side
      // holders in setting order — rightmost first, the centre slot is the
      // shamash's and never part of the count
      var ORDER = [4, 3, 2, 1, -1, -2, -3, -4], lit = {};
      for (i = 0; i < night; i++) lit[ORDER[i]] = 1;
      for (i = -4; i <= 4; i++) {
        var isShamash = i === 0;
        if (!isShamash && !lit[i]) continue;
        var cx = 17 + i * 3.6, top = isShamash ? 0.4 : 5.3;
        s += '<rect x="' + (cx - 0.9).toFixed(1) + '" y="' + top + '" width="1.8" height="4.2"' +
          ' rx=".4" fill="#F4F7FA" stroke="#D8DDE3" stroke-width=".3"/>';
        s += '<g class="m9-flame m9-f' + (i + 4) + '">' +
          '<path d="M' + cx + ' ' + (top - 3.4).toFixed(1) + ' q1.4 1.9 0 3.6 q-1.4 -1.7 0 -3.6"' +
          ' fill="#FF7A32"/>' +
          '<path d="M' + cx + ' ' + (top - 2.4).toFixed(1) + ' q.8 1.1 0 2.1 q-.8 -1 0 -2.1"' +
          ' fill="#FFC94A"/></g>';
      }

      s += '</g><g class="m9-drip"><circle cx="17.9" cy="6.5" r=".8" fill="#F4F7FA"/></g></svg>';
      return s;
    },

    // ── Styles ─────────────────────────────────────────────────────────────────
    // The flames never sit still; everything else moves as little as dignity
    // allows. No legs, so the walk is a sway and a shuffle.
    css: [
      '.m9-all{transform-origin:17px 30px}',
      '.m9-all{transition:transform .18s ease-out}',

      /* every flame breathes, each on its own beat */
      '@keyframes ycm9-flame{0%,100%{transform:scaleY(1) scaleX(1)}30%{transform:scaleY(1.18) scaleX(.92)}60%{transform:scaleY(.9) scaleX(1.06)}80%{transform:scaleY(1.1) scaleX(.95)}}',
      '.m9-flame{transform-box:fill-box;transform-origin:50% 100%;animation:ycm9-flame 1.5s ease-in-out infinite}',
      '.m9-f1{animation-delay:.2s}.m9-f2{animation-delay:.45s}.m9-f3{animation-delay:.1s}',
      '.m9-f4{animation-delay:.6s}.m9-f5{animation-delay:.3s}.m9-f6{animation-delay:.75s}',
      '.m9-f7{animation-delay:.15s}.m9-f8{animation-delay:.5s}',
      '.m9-drip{opacity:0}',

      /* walking: a slow processional sway — the flames trail it for free */
      '@keyframes ycm9-sway{0%,100%{transform:rotate(-1.6deg)}50%{transform:rotate(1.6deg)}}',
      '[data-state="walk"] .m9-all{animation:ycm9-sway 1.6s ease-in-out infinite}',
      '[data-state="idle"] .m9-all{transform:none}',

      /* airborne: flames stream upward, the whole piece tips a little */
      '[data-state="fall"] .m9-all{transform:rotate(-5deg)}',
      '[data-state="fall"] .m9-flame{animation-duration:.4s;transform:scaleY(1.5)}',

      /* the landing — heavy base, short squash, flames gutter then recover */
      '@keyframes ycm9-land{0%{transform:scaleY(.86) scaleX(1.08)}60%{transform:scaleY(1.03) scaleX(.98)}100%{transform:none}}',
      '[data-state="land"] .m9-all{animation:ycm9-land .22s ease-out}',
      '[data-state="land"] .m9-flame{animation-duration:.5s}',

      /* carried: tipped, flames bending against the motion */
      '[data-state="drag"] .m9-all{transform:rotate(-8deg)}',
      '[data-state="drag"] .m9-flame{animation-duration:.35s}',

      /* idle repertoire */
      '[data-act="rest"] .m9-all{transform:translateY(.5px)}',
      /* glow — noticed you: the halo comes up and the flames stand taller */
      '@keyframes ycm9-glow{0%,100%{opacity:.1}50%{opacity:.22}}',
      '[data-act="glow"] .m9-halo{animation:ycm9-glow 2.2s ease-in-out infinite}',
      '[data-act="glow"] .m9-flame{animation-duration:.9s;transform:scaleY(1.15)}',
      /* flicker — a draught goes by */
      '[data-act="flicker"] .m9-flame{animation-duration:.28s}',
      '@keyframes ycm9-shiver{0%,100%{transform:translateX(-.3px)}50%{transform:translateX(.3px)}}',
      '[data-act="flicker"] .m9-all{animation:ycm9-shiver .12s steps(2,end) infinite}',
      /* drip — one bead of wax down the shamash, on a loop long enough to be
         an event rather than a leak */
      '@keyframes ycm9-drip{0%,55%{opacity:0;transform:translateY(0)}60%{opacity:1}95%{opacity:1;transform:translateY(17px)}100%{opacity:0;transform:translateY(17px)}}',
      '[data-act="drip"] .m9-drip{animation:ycm9-drip 3.4s ease-in infinite}'
    ]
  });
})();
