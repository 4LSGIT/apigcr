/* public/js/mascot/skins/poltergeist.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, POLTERGEIST FORM — the third rowdy one
 *
 * The ghost is polite: it drifts through the page and touches nothing. This is
 * the ghost that touches things. It haunts — leans on whatever real element it
 * is nearest and leaves it crooked: a button sitting three degrees wrong, a
 * card skewed, a heading nudged off true. Nothing it does is permanent and
 * nothing it does is in your way: the tilt is a TRANSFORM, so the thing stays
 * exactly as clickable as it looks, and it straightens itself on its own clock,
 * the moment you press it, or the second the pet is grabbed or sent away.
 *
 * Mechanically it is the ghost's noclip travel — drift and blink, no gravity,
 * no ledges — with the haunt gear bolted on. The art is the difference: where
 * the ghost is a soft friendly sheet, this is barely there at all, a smear of
 * cold with two lights in it, and it goes fully transparent between blinks.
 *
 * It is not malicious. It is bored, and your page is the nearest furniture.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'poltergeist',
    name: 'Poltergeist',
    blurb: 'Leaves things crooked. Press whatever it tilted to straighten it.',

    geom: { W: 30, H: 34, FLY_HEAD: 34 },

    tune: {
      GRAVITY: 260,          // when it does fall, it falls like a rumour
      TERMINAL: 130,
      WALK: 26,
      DRIFT_CHANCE: 0.7,     // it barely touches the floor
      BLINK_MS: 0.34,
      HAUNT_CHANCE: 0.55     // and it cannot leave things alone
    },

    // The noclip set. No climb, no hang, no chase — it does not need to reach
    // you, it only needs to reach your furniture.
    can: ['walk', 'idle', 'fall', 'land', 'drag', 'leave', 'drift', 'blink'],

    // The haunt kit. Every pose is small on purpose — enough to be wrong,
    // never enough to push a thing over its neighbour.
    haunt: {
      max: 3,
      life: 12,
      sel: 'button,.card,.big-button,tr,th,h1,h2,h3,img,.panel,.tile',
      poses: [
        'rotate(-3deg)',
        'rotate(2.4deg)',
        'translateY(-5px) rotate(1.2deg)',
        'translateX(6px) rotate(-1.4deg)',
        'skewY(-1.8deg)',
        'scale(1.035) rotate(-2deg)',
        'translateY(4px) skewX(2deg)'
      ]
    },

    acts: [
      ['loom', 28], ['stare', 24], ['seethe', 22], ['scatter', 18]
    ],

    // When it notices you it stops pretending to be a draught.
    lookAct: 'stare',

    lines: [
      'I did not move it. It was always like that.',
      'Your furniture has opinions now.',
      'I file under duress. And at an angle.',
      'Objection: the table leaned first.',
      'Nothing here is level. You are welcome.',
      'I am a draught with standing.',
      'Straighten it. I will wait.',
      'The estate includes the crooked parts.',
      'I have no body and I must file.',
      'Every office has one. Yours has me.',
      'Tilt is a lifestyle.',
      'I audited your alignment. It failed.',
      'Press it and it stands up. Sad, really.',
      'Discovery? I have been through everything.',
      'Adjourned. Something behind you is wrong.'
    ],

    words: {
      idle: 'settle', drift: 'seep about', blink: 'flicker', haunt: 'lean on something',
      loom: 'loom', stare: 'stare', seethe: 'seethe', scatter: 'come apart'
    },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 30×34, facing +x. Deliberately less SOLID than the ghost: a torn column
    // of cold with a dark core and two lights in it. Three ragged layers drift
    // against each other so nothing about the outline is ever quite settled.
    svg:
      '<svg class="pg-svg" viewBox="0 0 30 34" width="30" height="34" aria-hidden="true" focusable="false">' +
      '<defs>' +
      '<radialGradient id="pgCore" cx="50%" cy="42%" r="62%">' +
      '<stop offset="0%" stop-color="#DCE8F8" stop-opacity=".95"/>' +
      '<stop offset="58%" stop-color="#7C90B4" stop-opacity=".62"/>' +
      '<stop offset="100%" stop-color="#4A5670" stop-opacity="0"/>' +
      '</radialGradient>' +
      '</defs>' +
      '<g class="pg-all">' +
      // the outermost tatter — the widest, faintest smear
      '<path class="pg-veil pg-v1" d="M15 1 C23 1 27 8 26.4 16 C26 22 28 26 26 30 C24 33 21 30 19 32'
      + ' C17 34 13 34 11 32 C9 30 6 33 4 30 C2 26 4 22 3.6 16 C3 8 7 1 15 1 Z"'
      + ' fill="#8294B4" opacity=".3"/>' +
      // the middle layer
      '<path class="pg-veil pg-v2" d="M15 3 C21.6 3 25 9 24.6 16 C24.3 21.4 26 25 24.4 28.4'
      + ' C22.8 31.4 20.4 28.6 18.6 30.4 C16.8 32.2 13.2 32.2 11.4 30.4'
      + ' C9.6 28.6 7.2 31.4 5.6 28.4 C4 25 5.7 21.4 5.4 16 C5 9 8.4 3 15 3 Z"'
      + ' fill="#66789A" opacity=".4"/>' +
      // the core it almost has
      '<path class="pg-core" d="M15 5 C20.4 5 23 10 22.7 16 C22.5 20.6 24 23.8 22.6 26.6'
      + ' C21.2 29.2 19.4 26.8 17.9 28.4 C16.4 30 13.6 30 12.1 28.4'
      + ' C10.6 26.8 8.8 29.2 7.4 26.6 C6 23.8 7.5 20.6 7.3 16 C7 10 9.6 5 15 5 Z"'
      + ' fill="url(#pgCore)"/>' +
      // two cold lights where a face would be if it bothered
      '<g class="pg-eyes">' +
      '<ellipse class="pg-eye" cx="11.6" cy="14.4" rx="1.7" ry="2.5" fill="#0E1520" opacity=".82"/>' +
      '<ellipse class="pg-eye" cx="18.4" cy="14.4" rx="1.7" ry="2.5" fill="#0E1520" opacity=".82"/>' +
      '<circle cx="11.6" cy="13.4" r=".62" fill="#D8ECFF"/>' +
      '<circle cx="18.4" cy="13.4" r=".62" fill="#D8ECFF"/>' +
      '</g>' +
      // the cold it drags with it
      '<g class="pg-chill">' +
      '<path d="M6.4 9.4 q-2.2 1.6 -1 3.6 M23.6 9.4 q2.2 1.6 1 3.6 M4.6 15.6 q-2.4 1.4 -1.2 3.4' +
      ' M25.4 15.6 q2.4 1.4 1.2 3.4" fill="none"' +
      ' stroke="#CFE6FF" stroke-width=".8" stroke-linecap="round" opacity=".75"/>' +
      '</g>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // Nothing here holds still and nothing here is opaque. The three veils run
    // the same drift at different speeds so the silhouette never repeats, and
    // the blink is a real dissolve — the engine fades the whole element, this
    // makes the inside come apart while it goes.
    css: [
      // the blink fade rides the skin's own root group, as the ghost's does —
      // the engine flips the state, the transition here carries it out
      '.pg-all{transform-origin:15px 20px;transition:transform .3s ease,opacity .34s ease}',
      '.pg-veil,.pg-core{transform-box:fill-box;transform-origin:50% 50%}',
      '.pg-eyes{transform-origin:15px 14.4px;transition:transform .25s ease}',
      // visible at rest as well as in motion: the portrait is the neutral
      // pose, and without these it is just the ghost again in the picker
      '.pg-chill{opacity:.6;transition:opacity .3s ease}',

      /* the constant unsettledness */
      '@keyframes ycpg-veil1{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(1.4px,-1.6px) scale(1.04)}66%{transform:translate(-1.2px,1.2px) scale(.97)}}',
      '@keyframes ycpg-veil2{0%,100%{transform:translate(0,0) scale(1)}40%{transform:translate(-1.6px,1.4px) scale(1.05)}72%{transform:translate(1px,-1px) scale(.98)}}',
      '@keyframes ycpg-core{0%,100%{transform:scale(1)}50%{transform:scale(1.04) translateY(-1px)}}',
      '.pg-v1{animation:ycpg-veil1 3.1s ease-in-out infinite}',
      '.pg-v2{animation:ycpg-veil2 2.3s ease-in-out infinite}',
      '.pg-core{animation:ycpg-core 2.7s ease-in-out infinite}',

      /* seeping about: it leans into the direction of travel and the cold shows */
      '[data-state="drift"] .pg-all{transform:rotate(-2deg) scaleY(1.05)}',
      '[data-state="drift"] .pg-chill{opacity:1}',

      /* the floor, which it resents */
      '@keyframes ycpg-trudge{0%,100%{transform:translateY(0) scaleY(1)}50%{transform:translateY(1.2px) scaleY(.96)}}',
      '[data-state="walk"] .pg-all{animation:ycpg-trudge .9s ease-in-out infinite}',
      '[data-state="idle"] .pg-all{transform:scaleY(.99)}',

      /* falling: it stretches out and streams */
      '[data-state="fall"] .pg-all{transform:scaleY(1.16) scaleX(.9)}',
      '[data-state="fall"] .pg-chill{opacity:1}',
      '@keyframes ycpg-land{0%{transform:scaleY(.8) scaleX(1.14)}60%{transform:scaleY(1.05) scaleX(.97)}100%{transform:none}}',
      '[data-state="land"] .pg-all{animation:ycpg-land .3s ease-out}',

      /* the dissolve: mid-blink the layers fly apart, so what fades is not a
         sprite going invisible but a thing coming undone */
      '@keyframes ycpg-undone{0%{transform:scale(1)}100%{transform:scale(1.5)}}',
      '[data-state="blink"] .pg-v1{animation:ycpg-undone .34s ease-out forwards}',
      '[data-state="blink"] .pg-v2{animation:ycpg-undone .34s ease-out .04s forwards}',
      '[data-state="blink"] .pg-eyes{transform:scale(.4)}',
      '[data-state="blink"] .pg-all{opacity:0}',

      /* carried: it does not struggle. It looks at you. */
      '[data-state="drag"] .pg-all{transform:scaleY(1.1)}',
      '[data-state="drag"] .pg-eyes{transform:translateY(1.5px) scale(1.12)}',

      /* idle repertoire */
      /* loom — it gets bigger. That is the whole act. */
      '@keyframes ycpg-loom{0%,100%{transform:scale(1)}55%{transform:scale(1.14) translateY(-2px)}}',
      '[data-act="loom"] .pg-all{animation:ycpg-loom 3.4s ease-in-out infinite}',
      /* stare — everything else stops moving. The eyes do not. */
      '@keyframes ycpg-fix{0%,100%{transform:translateX(-.8px)}50%{transform:translateX(.8px)}}',
      '[data-act="stare"] .pg-eyes{animation:ycpg-fix 2.6s ease-in-out infinite;transform-origin:15px 14.4px}',
      '[data-act="stare"] .pg-v1,[data-act="stare"] .pg-v2{animation-duration:6s}',
      /* seethe — a fast, tight vibration: the poltergeist equivalent of pacing */
      '@keyframes ycpg-seethe{0%,100%{transform:translate(-.7px,0)}50%{transform:translate(.7px,-.4px)}}',
      '[data-act="seethe"] .pg-all{animation:ycpg-seethe .09s linear infinite}',
      '[data-act="seethe"] .pg-chill{opacity:1}',
      /* scatter — it briefly stops being one thing */
      '@keyframes ycpg-scatterA{0%,100%{transform:translate(0,0)}50%{transform:translate(-3.5px,-2px) scale(1.08)}}',
      '@keyframes ycpg-scatterB{0%,100%{transform:translate(0,0)}50%{transform:translate(3.5px,2px) scale(1.08)}}',
      '[data-act="scatter"] .pg-v1{animation:ycpg-scatterA 1.5s ease-in-out infinite}',
      '[data-act="scatter"] .pg-v2{animation:ycpg-scatterB 1.5s ease-in-out infinite}',

      /* what it leaves behind: the crooked thing gets a breath of cold too, so
         a tilt reads as haunted rather than as a css bug */
      '.yc-haunted{filter:drop-shadow(0 0 6px rgba(150,180,220,.45))}'
    ]
  });
})();
