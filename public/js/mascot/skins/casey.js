/* public/js/mascot/skins/casey.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, THE YISRACAT — the reference skin
 *
 * Named in September 2026. A ginger cat, and the animal this whole feature was
 * built around: the engine's defaults ARE Casey's numbers, so this file carries
 * no `tune` at all — a skin really is just data, and this one is the least of
 * it there can be.
 *
 * The artwork rules, inherited from the single-file days and still right:
 * the fills stay literal, because this is ARTWORK, not chrome. A ginger cat has
 * to read as a ginger cat in both themes, and there is no token for "cat".
 * Dark mode is handled by the engine's brightness filter, not by repainting the
 * sprite. The two pieces of this widget that ARE app UI — the speech bubble and
 * the sleep z's — take app tokens.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'casey',
    name: 'Casey',
    blurb: 'A ginger cat. Walks the ledges, naps on your case list.',

    // 36×28, feet on the bottom edge. FLY_HEAD is the balloon's crown: it lives
    // ABOVE the viewBox, at y −23.8, i.e. 52px above the feet at y 28. Change
    // the geometry in the SVG and this number has to change with it.
    geom: { W: 36, H: 28, FLY_HEAD: 52 },

    // No tune: the engine defaults are Casey's numbers.

    // Idle repertoire, with weights. This is where the personality lives.
    // sleep is sided — a sleeping cat always faces right, so the floating z's
    // are never mirrored — and runs long, both ambiently and from the console.
    acts: [
      ['sit', 26], ['look', 20], ['groom', 18],
      ['sleep', 14, { face: 1, dur: [4, 9], cmdDur: [6, 12] }],
      ['stretch', 12], ['scratch', 10]
    ],

    // What it says when poked. House rules for adding one: keep it short enough
    // to read at a glance in a 250px bubble, keep it in a cat's voice rather
    // than the app's, and never let it refer to anything real — no counts, no
    // deadlines, no names. A bubble that could be mistaken for a notification
    // is the one way this stops being funny on someone's screen.
    lines: [
      'I have reviewed the file. It is warm.',
      'Six minutes of grooming. Bill it.',
      'Motion to nap. Granted.',
      'Objection. That chair was mine.',
      'Discovery: something under the couch.',
      'Everything on this ledge is mine now.',
      'Approach the bench. Bring snacks.',
      'Counsel, you have crumbs.',
      'Retainer: one tin. Daily.',
      'I read the contract. It tasted fine.',
      'Filed under: the floor.',
      'This desk needs more sunbeam.',
      'I have no notes.',
      'I am not stuck. This is deliberate.',
      'Adjourned. I am going to sleep.'
    ],

    // The trick panel's prose for the two or three action names that do not
    // read as instructions; everything else appears under its own name.
    words: { idle: 'settle', fly: 'balloon', chase: 'chase me', look: 'look about' },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 36×28, side view, facing right, feet on the bottom edge of the box. Parts
    // are grouped so the CSS below can pose them per state. The neutral pose is
    // standing — which is also the picker portrait, per the contract.
    svg:
      '<svg class="m-svg" viewBox="0 0 36 28" width="36" height="28" aria-hidden="true" focusable="false">' +
      // The balloon lives ABOVE the viewBox, which works because the svg is
      // overflow:visible (the sleep z's already do it). It sits outside .m-all so
      // it does not inherit the body's bob and squash — and so the cat can swing
      // underneath it during the float while the balloon itself stays put.
      '<g class="m-bal">' +
      '<path class="m-string" d="M20 -3 q-3 7 -2.4 10.5 q.4 2.4 -.6 3.9" fill="none" stroke="#B0783A" stroke-width=".9" stroke-linecap="round"/>' +
      '<g class="m-balloon">' +
      '<ellipse cx="20" cy="-14" rx="8.3" ry="9.8" fill="#E4574C"/>' +
      '<ellipse cx="16.8" cy="-18" rx="2.4" ry="3.2" fill="#F6A79F" opacity=".8"/>' +
      '<path d="M18.4 -4.5 L21.6 -4.5 L20 -1.7 Z" fill="#C4443A"/>' +
      '</g>' +
      // Shards start ON the rim and fly outward, rather than growing out of the
      // middle — a burst radiating from the centre just paints over the skin that
      // is still fading and reads as a smudge, not a pop.
      '<g class="m-shards">' +
      '<path d="M11.7 -14 l-4.6 -.6 M28.3 -14 l4.6 -.6 M20 -23.8 l.6 -4.6' +
      ' M14.1 -20.9 l-3.2 -3.4 M25.9 -20.9 l3.2 -3.4' +
      ' M14.1 -7.1 l-3.2 3.2 M25.9 -7.1 l3.2 3.2"' +
      ' fill="none" stroke="#E4574C" stroke-width="1.7" stroke-linecap="round"/>' +
      '</g></g>' +
      '<g class="m-all">' +
      '<path class="m-tail" d="M6 15 C1 15.5 -0.5 9 2.5 5.5" fill="none" stroke="#D9762F" stroke-width="2.8" stroke-linecap="round"/>' +
      '<g class="m-leg m-bl"><rect x="8" y="17.5" width="3.4" height="10.5" rx="1.7" fill="#CE7130"/></g>' +
      '<g class="m-leg m-fl"><rect x="19" y="17.5" width="3.4" height="10.5" rx="1.7" fill="#CE7130"/></g>' +
      '<rect class="m-body" x="5" y="11" width="23" height="11" rx="5.5" fill="#E8833A"/>' +
      '<path class="m-stripe" d="M11 12.2v3.4 M15 12v4 M19 12.2v3.4" stroke="#C96A28" stroke-width="1.6" stroke-linecap="round"/>' +
      '<g class="m-leg m-br"><rect x="11.6" y="17.5" width="3.4" height="10.5" rx="1.7" fill="#E8833A"/></g>' +
      '<g class="m-leg m-fr"><rect x="22.6" y="17.5" width="3.4" height="10.5" rx="1.7" fill="#E8833A"/></g>' +
      '<g class="m-head">' +
      '<path d="M23.6 8.4 L25.2 2.4 L28.8 6.6 Z" fill="#E8833A"/>' +
      '<path d="M31 5.4 L33.8 1.8 L34.6 7 Z" fill="#D9762F"/>' +
      '<circle cx="29.4" cy="10" r="6.2" fill="#EE8F45"/>' +
      '<circle class="m-eye" cx="31.9" cy="8.9" r="1.15" fill="#2A2118"/>' +
      '<path class="m-lid" d="M30.5 8.9 h2.8" stroke="#2A2118" stroke-width="1.3" stroke-linecap="round"/>' +
      '<circle cx="34.2" cy="11.4" r="1" fill="#F7DCC1"/>' +
      '<path d="M33.2 13.2 q1 .9 2 .1" stroke="#C96A28" stroke-width=".8" fill="none" stroke-linecap="round"/>' +
      '</g></g>' +
      '<g class="m-zzz">' +
      '<text class="m-z1" x="32" y="1">z</text>' +
      '<text class="m-z2" x="35" y="-4">z</text>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // Poses and gaits only: the container, the sprite box, the bubble and the
    // logo charge are the engine's. A function, because three of the animation
    // durations come off the merged CFG.
    css: function (CFG) {
      return [
        /* pivots: legs swing from the hip, the head from the neck, the tail from the rump */
        '.m-bl{transform-origin:9.7px 18.5px}.m-br{transform-origin:13.3px 18.5px}',
        '.m-fl{transform-origin:20.7px 18.5px}.m-fr{transform-origin:24.3px 18.5px}',
        '.m-head{transform-origin:25px 12px}.m-tail{transform-origin:6px 15px}',
        '.m-all{transform-origin:18px 28px}',
        '.m-leg,.m-head,.m-tail,.m-all{transition:transform .18s ease-out}',

        /* the walk is two frames on purpose — the stutter is what makes it 1995 */
        '@keyframes ycm-legA{0%,49%{transform:rotate(17deg)}50%,100%{transform:rotate(-17deg)}}',
        '@keyframes ycm-legB{0%,49%{transform:rotate(-17deg)}50%,100%{transform:rotate(17deg)}}',
        '@keyframes ycm-bob{0%,49%{transform:translateY(0)}50%,100%{transform:translateY(-1px)}}',
        '@keyframes ycm-tail{0%{transform:rotate(-9deg)}50%{transform:rotate(11deg)}100%{transform:rotate(-9deg)}}',
        '@keyframes ycm-blinkLid{0%,95.5%,100%{opacity:0}96.5%,98.5%{opacity:1}}',
        '@keyframes ycm-blinkEye{0%,95.5%,100%{opacity:1}96.5%,98.5%{opacity:0}}',
        '.m-lid{opacity:0;animation:ycm-blinkLid 5.3s infinite}',
        '.m-eye{animation:ycm-blinkEye 5.3s infinite}',

        /* walk / chase / climb share a gait, at different tempos */
        '[data-state="walk"] .m-fr,[data-state="walk"] .m-bl,',
        '[data-state="chase"] .m-fr,[data-state="chase"] .m-bl,',
        '[data-state="climb"] .m-fr,[data-state="climb"] .m-bl,',
        '[data-state="hang"] .m-fr,[data-state="hang"] .m-bl{animation:ycm-legA .26s infinite}',
        '[data-state="walk"] .m-fl,[data-state="walk"] .m-br,',
        '[data-state="chase"] .m-fl,[data-state="chase"] .m-br,',
        '[data-state="climb"] .m-fl,[data-state="climb"] .m-br,',
        '[data-state="hang"] .m-fl,[data-state="hang"] .m-br{animation:ycm-legB .26s infinite}',
        '[data-state="walk"] .m-all,[data-state="chase"] .m-all{animation:ycm-bob .26s infinite}',
        '[data-state="chase"] .m-fr,[data-state="chase"] .m-bl,',
        '[data-state="chase"] .m-fl,[data-state="chase"] .m-br{animation-duration:.17s}',
        '[data-state="climb"] .m-fr,[data-state="climb"] .m-bl,',
        '[data-state="climb"] .m-fl,[data-state="climb"] .m-br{animation-duration:.34s}',
        '[data-state="hang"] .m-fr,[data-state="hang"] .m-bl,',
        '[data-state="hang"] .m-fl,[data-state="hang"] .m-br{animation-duration:.42s}',
        '[data-state="walk"] .m-tail,[data-state="idle"] .m-tail{animation:ycm-tail 1.15s ease-in-out infinite}',
        '[data-state="chase"] .m-tail{animation:ycm-tail .5s ease-in-out infinite}',

        /* airborne: legs splay, tail streams */
        '[data-state="fall"] .m-fl,[data-state="fall"] .m-fr{transform:rotate(-34deg)}',
        '[data-state="fall"] .m-bl,[data-state="fall"] .m-br{transform:rotate(30deg)}',
        '[data-state="fall"] .m-tail{transform:rotate(-32deg)}',
        '[data-state="fall"] .m-head{transform:rotate(-8deg)}',

        /* dropping to a lower perch: the wind-up, then the tuck. The .18s transition
           on .m-all is what makes the crouch read as a gather rather than a pop. */
        '[data-state="crouch"] .m-all{transform:translateY(3px) scaleY(.80) scaleX(1.09)}',
        '[data-state="crouch"] .m-head{transform:rotate(7deg)}',      /* eyeing the landing */
        '[data-state="crouch"] .m-tail{transform:rotate(-20deg)}',
        '[data-state="hop"] .m-fl,[data-state="hop"] .m-fr{transform:rotate(-26deg)}',
        '[data-state="hop"] .m-bl,[data-state="hop"] .m-br{transform:rotate(22deg)}',
        '[data-state="hop"] .m-tail{transform:rotate(-30deg)}',
        '[data-state="hop"] .m-head{transform:rotate(6deg)}',
        '[data-state="hop"] .m-all{transform:scaleY(1.06) scaleX(.95)}',

        /* ── the balloon ─────────────────────────────────────────────────────────
           Shown ONLY by these three state selectors, and hidden by default. That is
           load-bearing, not tidiness: it means toLeave(), a drag, and every other
           way out of a float all put the balloon away for free, without a single
           one of them having to know it exists. */
        '.m-bal{opacity:0}',
        '[data-state="inflate"] .m-bal,[data-state="float"] .m-bal,[data-state="pop"] .m-bal{opacity:1}',
        '.m-balloon{transform-origin:20px -3.5px}',   /* the knot — it fills from there */
        '.m-shards{transform-origin:20px -14px;opacity:0}',
        '@keyframes ycm-inflate{0%{transform:scale(.05)}60%{transform:scale(1.11)}80%{transform:scale(.97)}100%{transform:scale(1)}}',
        '@keyframes ycm-bobble{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}',
        /* the skin goes early and the shards outlive it, or the two overlap for most
           of the burst and it reads as the balloon melting rather than popping */
        '@keyframes ycm-burst{0%{transform:scale(1);opacity:1}30%{transform:scale(1.24);opacity:.5}55%,100%{transform:scale(1.32);opacity:0}}',
        '@keyframes ycm-shards{0%{transform:scale(1);opacity:1}70%{opacity:.9}100%{transform:scale(2);opacity:0}}',
        '@keyframes ycm-swing{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(7deg)}}',
        '[data-state="inflate"] .m-balloon{animation:ycm-inflate ' + CFG.INFLATE_MS + 's ease-out both}',
        '[data-state="inflate"] .m-all{transform:translateY(2px) scaleY(.94) scaleX(1.05)}',
        '[data-state="inflate"] .m-head{transform:rotate(-17deg)}',   /* watching it fill */
        '[data-state="inflate"] .m-tail{transform:rotate(-12deg)}',
        '[data-state="float"] .m-balloon{animation:ycm-bobble 2.9s ease-in-out infinite}',
        /* the pivot moves to the KNOT for the float, so the cat swings from the
           string like a pendulum instead of about its own feet. The balloon is
           outside .m-all, so it holds still while the cat sways under it. */
        '[data-state="float"] .m-all{transform-origin:20px -2px;animation:ycm-swing 2.4s ease-in-out infinite}',
        /* NOT a dangle on all four: four legs swinging in antiphase is a gait, and a
           floating cat that appears to be walking is the whole illusion gone. The
           front pair holds the splay the fall pose uses — which already reads as
           airborne — and only the back pair swings, slowly enough to be a sway. */
        '[data-state="float"] .m-fl,[data-state="float"] .m-fr{transform:rotate(-18deg)}',
        '[data-state="float"] .m-bl,[data-state="float"] .m-br{animation:ycm-dangle 1.7s ease-in-out infinite}',
        '[data-state="float"] .m-br{animation-delay:.85s}',
        '[data-state="float"] .m-tail{transform:rotate(16deg)}',
        '[data-state="float"] .m-head{transform:rotate(-7deg)}',
        '[data-state="pop"] .m-balloon{animation:ycm-burst ' + CFG.POP_MS + 's ease-out forwards}',
        '[data-state="pop"] .m-shards{opacity:1;animation:ycm-shards ' + CFG.POP_MS + 's ease-out forwards}',
        '[data-state="pop"] .m-string{opacity:0}',
        '[data-state="pop"] .m-head{transform:rotate(-15deg)}',       /* startled */
        '[data-state="pop"] .m-fl,[data-state="pop"] .m-fr{transform:rotate(-38deg)}',
        '[data-state="pop"] .m-bl,[data-state="pop"] .m-br{transform:rotate(34deg)}',
        '[data-state="pop"] .m-all{transform:scaleY(.94) scaleX(1.07)}',

        /* the landing squash */
        '@keyframes ycm-land{0%{transform:scaleY(.68) scaleX(1.18)}60%{transform:scaleY(1.06) scaleX(.96)}100%{transform:none}}',
        '[data-state="land"] .m-all{animation:ycm-land .22s ease-out}',

        /* held by the scruff */
        '@keyframes ycm-dangle{0%{transform:rotate(-14deg)}50%{transform:rotate(14deg)}100%{transform:rotate(-14deg)}}',
        '[data-state="drag"] .m-leg{animation:ycm-dangle .32s ease-in-out infinite}',
        '[data-state="drag"] .m-br,[data-state="drag"] .m-fr{animation-delay:.16s}',
        '[data-state="drag"] .m-tail{transform:rotate(-24deg)}',

        /* idle repertoire */
        '[data-act="sit"] .m-all{transform:translateY(2px)}',
        '[data-act="sit"] .m-bl,[data-act="sit"] .m-br{transform:rotate(62deg)}',
        '@keyframes ycm-look{0%,20%{transform:rotate(0)}35%,50%{transform:rotate(-15deg)}65%,80%{transform:rotate(13deg)}100%{transform:rotate(0)}}',
        '[data-act="look"] .m-head{animation:ycm-look 3.4s ease-in-out infinite}',
        '@keyframes ycm-groomH{0%,100%{transform:rotate(0)}40%,70%{transform:rotate(26deg) translateY(1px)}}',
        '@keyframes ycm-groomP{0%,100%{transform:rotate(0)}40%{transform:rotate(-64deg)}55%{transform:rotate(-52deg)}70%{transform:rotate(-64deg)}}',
        '[data-act="groom"] .m-head{animation:ycm-groomH 1.8s ease-in-out infinite}',
        '[data-act="groom"] .m-fr{animation:ycm-groomP 1.8s ease-in-out infinite}',
        '[data-act="groom"] .m-all{transform:translateY(2px)}',
        '@keyframes ycm-stretch{0%,100%{transform:none}45%{transform:scaleX(1.16) scaleY(.86) translateY(2px)}}',
        '[data-act="stretch"] .m-all{animation:ycm-stretch 2.2s ease-in-out infinite}',
        '[data-act="stretch"] .m-tail{transform:rotate(-34deg)}',
        '@keyframes ycm-scratch{0%,100%{transform:rotate(-58deg)}50%{transform:rotate(-44deg)}}',
        '[data-act="scratch"] .m-bl{animation:ycm-scratch .13s infinite}',
        '[data-act="scratch"] .m-all{transform:translateY(2px)}',
        '[data-act="scratch"] .m-head{transform:rotate(-9deg)}',

        /* asleep — the cat always faces right here (acts opts) so the z\'s are
           never mirrored */
        '[data-act="sleep"] .m-all{transform:translateY(4px) scaleY(.82) scaleX(1.05)}',
        '[data-act="sleep"] .m-leg{transform:rotate(72deg)}',
        '[data-act="sleep"] .m-lid{opacity:1;animation:none}',
        '[data-act="sleep"] .m-eye{opacity:0;animation:none}',
        '[data-act="sleep"] .m-tail{transform:rotate(24deg)}',
        '.m-zzz{opacity:0}',
        // The z's are muted text over the page, so they take the app token. Was
        // #8a8f98 light (2.90 on --page-bg) and #c8ced8 dark; --text-muted is
        // 5.69 / 5.93.
        '.m-zzz text{font:italic 700 7px/1 Georgia,serif;fill:var(--text-muted);',
        'transform-box:fill-box;transform-origin:50% 50%}',   /* each z scales about itself */
        '@keyframes ycm-z{0%{opacity:0;transform:translate(0,0) scale(.7)}25%{opacity:.9}100%{opacity:0;transform:translate(4px,-9px) scale(1.1)}}',
        '[data-act="sleep"] .m-zzz{opacity:1}',
        '[data-act="sleep"] .m-z1{animation:ycm-z 2.6s ease-out infinite}',
        '[data-act="sleep"] .m-z2{animation:ycm-z 2.6s ease-out infinite 1.3s}'
      ];
    }
  });
})();
