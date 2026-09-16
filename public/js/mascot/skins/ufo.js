/* public/js/mascot/skins/ufo.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, UFO FORM — the abduction one
 *
 * A flying saucer, and the best-value entry in the catalogue: it needs NO new
 * engine code at all. The noclip pair is its cruise (drift) and its warp
 * (blink), and the engine's inflate/float/pop ascent IS beam-on, tractor-rise
 * and beam-off — the beam and the cow live in this SVG the way Casey's
 * balloon does, hidden until those three states show them. During the float
 * the cow rises up the beam; at the pop the beam snaps shut and the cow is
 * gone. The cow is OURS — a sprite in the beam, never a page element: nothing
 * about an abduction reaches into the app.
 *
 * The trick panel writes itself: this skin's word for the engine's `fly`
 * action is "abduct a cow".
 *
 * Pickable year-round, deliberately unseasonal: the old plan pencilled it in
 * for July 4th (the Independence Day joke, by way of Roswell), and a seasonal
 * gag that needs the footnote does not earn the table row. If it ever gets
 * one, July 2 — World UFO Day — is the literal fit.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'ufo',
    name: 'UFO',
    blurb: 'Hovers, warps, abducts the odd cow.',

    // A low saucer; the hull's underside is the foot line, and nothing sticks
    // up past the dome, so FLY_HEAD is the sprite's own height — the strip
    // under the header is an ordinary abduction target.
    geom: { W: 36, H: 18, FLY_HEAD: 18 },

    tune: {
      GRAVITY: 500,          // it settles rather than plummets
      TERMINAL: 200,
      WALK: 34,              // ledge patrol is a glide
      CHASE: 95,
      DRIFT_CHANCE: 0.4,     // the cruise
      FLY_LIFT: 200,         // tractor beams do not dawdle
      FLY_MAX_VY: 110,
      INFLATE_MS: 1.1,       // the beam powering up deserves its beat
      POP_MS: 0.3            // the snap-off, and the cow's last few feet
    },

    // Everything but the climbing-animal set: walls and ceilings are for
    // things with feet, and a saucer does not hop — it has a warp drive.
    can: ['walk', 'idle', 'chase', 'fall', 'land', 'drag', 'leave',
      'drift', 'blink', 'inflate', 'float', 'pop'],

    acts: [
      ['hover', 28], ['scan', 22], ['spin', 16], ['beep', 16]
    ],

    // When it notices you, it scans.
    lookAct: 'scan',

    lines: [
      'We come in peace. And for the crumbs.',
      'Your ledges have been surveyed. Nice ledges.',
      'The cow is fine. The cow is a consultant now.',
      'Probing is billable at 0.2 hours.',
      'Take me to your managing partner.',
      'This desk is now a designated landing site.',
      'Crop circles are just very rural exhibits.',
      'Jurisdiction: everywhere above the floor.',
      'I filed my flight plan with no one.',
      'Abduction? We prefer "expedited intake."',
      'Scanning… mostly staplers down there.',
      'The truth is in here, actually.',
      'Warp jumps are billed as travel time.',
      'I hover because chairs are a scam.',
      'Adjourned. Beam me sideways.'
    ],

    words: {
      idle: 'settle', fly: 'abduct a cow', chase: 'chase me',
      drift: 'cruise about', blink: 'warp', scan: 'scan about'
    },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 36×18, side view, hull underside on the bottom edge. The beam, the cow
    // and the little search cone all hang BELOW the viewBox (the svg is
    // overflow:visible); the dome and pilot ride on top of the hull. Neutral
    // pose is the parked saucer — the portrait.
    svg:
      '<svg class="u-svg" viewBox="0 0 36 18" width="36" height="18" aria-hidden="true" focusable="false">' +
      '<g class="u-all">' +
      // THE BEAM, drawn first so the hull overlaps its root. Hidden except in
      // the ascent states — that hiding is load-bearing, exactly as the
      // balloon's was: every way out of an ascent puts the beam away for free.
      '<g class="u-beam">' +
      '<path d="M12.5 14 L6 44 L30 44 L23.5 14 Z" fill="#FFE9A8" opacity=".5"/>' +
      '<path d="M14.5 14 L10.5 44 L25.5 44 L21.5 14 Z" fill="#FFF6D6" opacity=".55"/>' +
      // the abductee: airborne, mildly resigned, legs stiff
      '<g class="u-cow">' +
      '<ellipse cx="18" cy="33" rx="4.2" ry="2.4" fill="#F4F7FA" stroke="#2A2118" stroke-width=".45"/>' +
      '<circle cx="16.4" cy="32.4" r="1.1" fill="#2A2118"/>' +
      '<circle cx="19.9" cy="33.9" r=".8" fill="#2A2118"/>' +
      '<circle cx="22.4" cy="31.4" r="1.6" fill="#F4F7FA" stroke="#2A2118" stroke-width=".45"/>' +
      '<ellipse cx="23.2" cy="32" rx=".95" ry=".65" fill="#F0B9C4"/>' +
      '<circle cx="22.2" cy="30.8" r=".3" fill="#2A2118"/>' +
      '<path d="M21.3 30.1 l-.8 -.7 M23.4 30 l.7 -.8" stroke="#2A2118" stroke-width=".4" stroke-linecap="round"/>' +
      '<path d="M15.4 35.1 v2 M17.2 35.4 v2 M18.9 35.4 v2 M20.6 35.1 v2" stroke="#2A2118" stroke-width=".7" stroke-linecap="round"/>' +
      '<path d="M14 33.4 q-1.4 .9 -1 2.1" fill="none" stroke="#2A2118" stroke-width=".5" stroke-linecap="round"/>' +
      '</g></g>' +
      // the search cone for the scan act — a politer, smaller beam
      '<g class="u-scanner">' +
      '<path d="M16.4 15 L13 26 L23 26 L19.6 15 Z" fill="#4FE3C1" opacity=".3"/>' +
      '</g>' +
      // THE HULL — a bevelled disc: dark underside, bright top face, a hatch
      // ring at the centre of the belly, running lights on the rim.
      '<g class="u-body">' +
      '<ellipse cx="18" cy="12.2" rx="14.2" ry="4.6" fill="#AEB5BE" stroke="#2F343B" stroke-width=".7"/>' +
      '<ellipse cx="18" cy="11" rx="13" ry="3.4" fill="#C6CAD0"/>' +
      '<path d="M5.6 11.2 Q18 8.2 30.4 11.2" fill="none" stroke="#F4F7FA" stroke-width=".9" stroke-linecap="round"/>' +
      '<ellipse cx="18" cy="14.8" rx="3.4" ry="1.2" fill="#5A616B" stroke="#2F343B" stroke-width=".5"/>' +
      '<ellipse cx="18" cy="14.7" rx="2.1" ry=".7" fill="#23272E"/>' +
      '<circle class="u-l u-l1" cx="6.5" cy="12.9" r=".9" fill="#FFC94A"/>' +
      '<circle class="u-l u-l2" cx="12" cy="14" r=".9" fill="#FFC94A"/>' +
      '<circle class="u-l u-l3" cx="18" cy="14.4" r=".9" fill="#FFC94A"/>' +
      '<circle class="u-l u-l4" cx="24" cy="14" r=".9" fill="#FFC94A"/>' +
      '<circle class="u-l u-l5" cx="29.5" cy="12.9" r=".9" fill="#FFC94A"/>' +
      // THE DOME and its pilot — glass, glint, and a small green employee
      '<path d="M11.5 9.5 Q11.5 2.6 18 2.6 Q24.5 2.6 24.5 9.5 Z" fill="#BFF3E6" opacity=".88" stroke="#2F343B" stroke-width=".6"/>' +
      '<g class="u-pilot">' +
      '<rect x="17.2" y="8" width="2.8" height="1.6" rx=".8" fill="#8FD98A"/>' +
      '<ellipse cx="18.6" cy="6.6" rx="1.9" ry="2.2" fill="#8FD98A" stroke="#2F343B" stroke-width=".4"/>' +
      '<ellipse cx="17.9" cy="6.4" rx=".5" ry=".7" fill="#2A2118"/>' +
      '<ellipse cx="19.4" cy="6.4" rx=".5" ry=".7" fill="#2A2118"/>' +
      '</g>' +
      '<path d="M13.4 7.6 Q13.8 4.3 16.2 3.3" fill="none" stroke="#FFFFFF" stroke-width=".8" opacity=".7" stroke-linecap="round"/>' +
      '</g></g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // The bob lives on .u-all (whole craft), tilts and wobbles on .u-body
    // (hull only), so the two never fight over one transform — and the beam,
    // anchored under the hull, never bobs while a cow is in transit (the
    // ascent states define no bob at all: a tractor beam is a steady hand).
    css: function (CFG) {
      return [
        '.u-all{transform-origin:18px 18px;transition:transform .18s ease,opacity .18s ease}',
        '.u-body{transform-origin:18px 12px;transition:transform .18s ease-out}',
        '.u-beam{transform-origin:18px 14px;opacity:0}',
        '.u-cow{transform-origin:18px 33px}',
        '.u-scanner{transform-origin:18px 15px;opacity:0}',
        '.u-pilot{transform-box:fill-box;transform-origin:50% 60%}',

        /* the running lights chase each other around the rim, always */
        '@keyframes ycu-light{0%,100%{opacity:.2}50%{opacity:1}}',
        '.u-l{animation:ycu-light 1.6s infinite}',
        '.u-l2{animation-delay:.32s}.u-l3{animation-delay:.64s}',
        '.u-l4{animation-delay:.96s}.u-l5{animation-delay:1.28s}',

        /* hover is the resting state of a thing with no legs */
        '@keyframes ycu-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.5px)}}',
        '[data-state="idle"] .u-all{animation:ycu-bob 2.8s ease-in-out infinite}',
        '[data-state="walk"] .u-all{animation:ycu-bob 1.6s ease-in-out infinite}',
        '[data-state="chase"] .u-all{animation:ycu-bob .8s ease-in-out infinite}',
        '[data-state="chase"] .u-l{animation-duration:.5s}',
        '[data-state="chase"] .u-body{transform:rotate(-3deg)}',

        /* falling: destabilised — the wobble of a saucer that lost the plot */
        '@keyframes ycu-wobble{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}}',
        '[data-state="fall"] .u-body{animation:ycu-wobble .45s ease-in-out infinite}',
        '[data-state="fall"] .u-l{animation-duration:.2s}',

        /* the landing — a settle, not a clank */
        '@keyframes ycu-land{0%{transform:scaleY(.82) scaleX(1.1)}60%{transform:scaleY(1.04) scaleX(.98)}100%{transform:none}}',
        '[data-state="land"] .u-body{animation:ycu-land .22s ease-out}',

        /* carried: tipped and indignant about it */
        '[data-state="drag"] .u-body{transform:rotate(-10deg)}',
        '[data-state="drag"] .u-l{animation-duration:.15s}',

        /* cruising: the deep slow bob, a lazy roll on the hull */
        '@keyframes ycu-roll{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(2deg)}}',
        '[data-state="drift"] .u-all{animation:ycu-bob 3.2s ease-in-out infinite}',
        '[data-state="drift"] .u-body{animation:ycu-roll 3.2s ease-in-out infinite}',

        /* the warp: not a fade, a snap — stretched thin and gone */
        '[data-state="blink"] .u-all{opacity:0;transform:scaleX(1.3) scaleY(.7)}',

        /* ── the abduction — the engine\'s inflate/float/pop ──────────────────
           Beam-on, tractor-rise, beam-off. Shown ONLY by these selectors and
           hidden by default, inherited straight from the balloon: toLeave(), a
           drag, the ground going away mid-beam all put it away for free. */
        '@keyframes ycu-beamon{0%{opacity:0;transform:scaleY(.04)}35%{opacity:1;transform:scaleY(.55)}55%{transform:scaleY(.4)}100%{opacity:1;transform:scaleY(1)}}',
        '@keyframes ycu-cowrise{0%{opacity:0;transform:translateY(15px) rotate(-14deg)}25%{opacity:1}100%{opacity:1;transform:translateY(0) rotate(-14deg)}}',
        '@keyframes ycu-beamoff{0%{opacity:1;transform:scaleY(1)}100%{opacity:0;transform:scaleY(.03)}}',
        '@keyframes ycu-cowup{0%{opacity:1;transform:translateY(0) rotate(-14deg) scale(1)}100%{opacity:0;transform:translateY(-17px) rotate(-14deg) scale(.25)}}',
        '[data-state="inflate"] .u-beam{opacity:1;animation:ycu-beamon ' + CFG.INFLATE_MS + 's ease-out both}',
        '[data-state="inflate"] .u-cow{opacity:0}',
        '[data-state="inflate"] .u-l{animation-duration:.3s}',
        '[data-state="float"] .u-beam{opacity:1}',
        '[data-state="float"] .u-cow{animation:ycu-cowrise 1.9s ease-out both}',
        '[data-state="float"] .u-l{animation-duration:.3s}',
        '[data-state="pop"] .u-beam{opacity:1;animation:ycu-beamoff ' + CFG.POP_MS + 's ease-in forwards}',
        '[data-state="pop"] .u-cow{animation:ycu-cowup ' + CFG.POP_MS + 's ease-in forwards}',

        /* idle repertoire */
        '[data-act="hover"] .u-all{animation-duration:2s}',
        /* scan: the polite little survey cone sweeps under the hull */
        '@keyframes ycu-sweep{0%,100%{opacity:.35;transform:rotate(-13deg)}50%{opacity:.35;transform:rotate(13deg)}}',
        '[data-act="scan"] .u-scanner{animation:ycu-sweep 2.6s ease-in-out infinite}',
        /* spin: the pilot does a twirl and the rim goes to party mode */
        '@keyframes ycu-twirl{to{transform:rotate(360deg)}}',
        '[data-act="spin"] .u-pilot{animation:ycu-twirl .9s linear infinite}',
        '[data-act="spin"] .u-l{animation-duration:.12s}',
        /* beep: the lights argue in odd and even */
        '@keyframes ycu-odd{0%,49%{opacity:1}50%,100%{opacity:.15}}',
        '@keyframes ycu-even{0%,49%{opacity:.15}50%,100%{opacity:1}}',
        '[data-act="beep"] .u-l1,[data-act="beep"] .u-l3,[data-act="beep"] .u-l5{animation:ycu-odd .5s steps(1,end) infinite}',
        '[data-act="beep"] .u-l2,[data-act="beep"] .u-l4{animation:ycu-even .5s steps(1,end) infinite}'
      ];
    }
  });
})();
