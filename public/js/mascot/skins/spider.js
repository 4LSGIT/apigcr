/* public/js/mascot/skins/spider.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, SPIDER FORM — the rowdy one
 *
 * The skin the §2a argument was about, built on the terms that ended it:
 * its webs are world objects, so they can NEVER take a click (the engine's
 * !important wildcard), they are capped and they fade on a clock, they never
 * spawn over an input or the focused element, and they break the moment the
 * pointer touches them — a distance test against the cursor the engine
 * already tracks, which also means a touch tap breaks one on first contact.
 * Rowdy, and it says so: the manifest flags it, the picker badges it, and
 * the blurb warns in plain words before anyone chooses it. Send-it-away
 * still works instantly, mid-web — teardown takes the whole layer.
 *
 * Otherwise it is the best mover in the catalogue: fastest climber, a
 * skittering chase, real jumps (a jumping spider, taxonomically defensible),
 * and it descends on a visible thread whenever it is airborne, because a
 * spider that merely falls is just a raisin with legs.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'spider',
    name: 'Spider',
    blurb: 'A spider. Spins webs where you work — one touch of the pointer breaks them. Rowdy.',

    // Small and wide. No ascent in `can`, so FLY_HEAD is the sprite's own
    // height per the contract's convention.
    geom: { W: 24, H: 12, FLY_HEAD: 12 },

    tune: {
      WALK: 40,
      CLIMB: 72,             // the best climber in the building
      HANGSPEED: 44,         // the ceiling is its second floor
      CHASE: 110,            // the skitter
      GRAVITY: 650           // it descends on silk, it does not plummet
    },

    // Everything with feet: walks, climbs, hangs, jumps, chases. No ascent
    // (it has thread for that story) and no noclip (it is EXTREMELY clipped —
    // surfaces are its entire personality).
    can: ['walk', 'idle', 'chase', 'climb', 'hang', 'fall', 'hop', 'crouch',
      'land', 'drag', 'leave'],

    acts: [
      ['rest', 22], ['spin', 26], ['twitch', 20], ['tap', 16]
    ],

    // When it notices you, it twitches. Of course it does.
    lookAct: 'twitch',

    // The webs. Only a finished `spin` leaves one, at most a third of the
    // time, five on screen, fading out over three quarters of a minute — and
    // the engine holds the §2a lines above.
    web: {
      chance: 0.35,
      act: 'spin',
      life: 45,
      max: 5,
      w: 30, h: 26,
      breakR: 18,
      svg: '<svg width="30" height="26" viewBox="0 0 30 26">' +
        '<g fill="none" stroke="#B9C2CF" stroke-width=".6" opacity=".65">' +
        '<path d="M15 24 V2 M15 24 L4 6 M15 24 L26 6 M15 24 L1.5 16 M15 24 L28.5 16"/>' +
        '<path d="M11 17.5 Q15 15.6 19 17.5 M8 12.4 Q15 9.2 22 12.4 M5.6 7.6 Q15 3 24.4 7.6"/>' +
        '</g>' +
        '<circle cx="15" cy="21" r=".9" fill="#B9C2CF" opacity=".7"/>' +
        '</svg>'
    },

    lines: [
      'I have retained myself on a web basis.',
      'Eight legs, one billable mind.',
      'The web is up. Traffic pending.',
      'I do my filings in silk.',
      'Your cursor walked into MY office.',
      'Exhibit W. It glitters. Do not touch.',
      'I never miss a deadline. I hang from them.',
      'Settlement web: everything sticks.',
      'The small print is mine. I spun it.',
      'The ceiling is just my second floor.',
      'I sublet the corners.',
      'Startled? That was a scheduled descent.',
      'Motion practice: all eight, in order.',
      'The fly did not appear. Case dismissed.',
      'Adjourned. Mind the web on your way out.'
    ],

    words: { idle: 'settle', chase: 'chase me', spin: 'spin a web', tap: 'drum', twitch: 'twitch' },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 24×12, side view, facing right, feet on the bottom edge: abdomen aft,
    // cephalothorax fore, four leg GROUPS (near/far, fore/aft — eight legs,
    // four pivots, which is all a 24px spider can articulate), and a silk
    // thread overhead that only the airborne states reveal.
    svg:
      '<svg class="p-svg" viewBox="0 0 24 12" width="24" height="12" aria-hidden="true" focusable="false">' +
      '<g class="p-all">' +
      '<path class="p-thread" d="M16 4 V-42" stroke="#B9C2CF" stroke-width=".6" opacity="0"/>' +
      // far legs first, a shade darker
      '<g class="p-leg p-lB">' +
      '<path d="M9 7.5 L5.5 4.6 L2.6 6.8 M11 8 L9 4 L5.8 3.4" fill="none" stroke="#26262E" stroke-width="1" stroke-linecap="round"/>' +
      '</g>' +
      '<g class="p-leg p-lD">' +
      '<path d="M15.5 7.5 L18.5 4.2 L21.8 5 M14 8 L16.8 3.6 L20 2.8" fill="none" stroke="#26262E" stroke-width="1" stroke-linecap="round"/>' +
      '</g>' +
      // the body: abdomen, cephalothorax, eyes, fangs
      '<ellipse class="p-abd" cx="8.2" cy="6.6" rx="5" ry="3.9" fill="#3A3A44" stroke="#1D1D24" stroke-width=".6"/>' +
      '<path d="M5.4 4.6 q2.6 -1.6 5.4 -.2" fill="none" stroke="#4E4E5A" stroke-width=".9" stroke-linecap="round"/>' +
      '<circle class="p-head" cx="15.6" cy="7.4" r="2.9" fill="#3A3A44" stroke="#1D1D24" stroke-width=".6"/>' +
      '<circle class="p-eye" cx="17" cy="6.6" r=".55" fill="#FF6B4A"/>' +
      '<circle class="p-eye" cx="17.8" cy="7.6" r=".45" fill="#FF6B4A"/>' +
      '<path d="M17.6 9.2 l.7 1.1 M18.4 8.6 l.9 .9" stroke="#1D1D24" stroke-width=".6" stroke-linecap="round"/>' +
      // near legs over the body
      '<g class="p-leg p-lA">' +
      '<path d="M10 8.5 L6.5 6 L3 9 M12 9 L10 5.4 L6.4 5.6" fill="none" stroke="#2F2F38" stroke-width="1.1" stroke-linecap="round"/>' +
      '</g>' +
      '<g class="p-leg p-lC">' +
      '<path d="M16.5 9 L19.5 6.2 L23 7.6 M15 9.3 L18 5.4 L21.6 4.4" fill="none" stroke="#2F2F38" stroke-width="1.1" stroke-linecap="round"/>' +
      '</g>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // The scuttle is four leg groups in alternating pairs, stepped — a spider
    // does not ease. The thread appears only while airborne, which turns every
    // fall and every carried dangle into a descent.
    css: [
      '.p-all{transform-origin:12px 12px;transition:transform .14s steps(2,end)}',
      '.p-lA{transform-origin:10px 8.5px}.p-lB{transform-origin:9px 7.5px}',
      '.p-lC{transform-origin:16.5px 9px}.p-lD{transform-origin:15.5px 7.5px}',
      '.p-leg{transition:transform .14s steps(2,end)}',
      '.p-thread{transition:opacity .15s ease}',

      /* the scuttle: A+D against B+C, fast and stepped */
      '@keyframes ycp-legA{0%,49%{transform:rotate(9deg)}50%,100%{transform:rotate(-9deg)}}',
      '@keyframes ycp-legB{0%,49%{transform:rotate(-9deg)}50%,100%{transform:rotate(9deg)}}',
      '[data-state="walk"] .p-lA,[data-state="walk"] .p-lD,',
      '[data-state="climb"] .p-lA,[data-state="climb"] .p-lD,',
      '[data-state="hang"] .p-lA,[data-state="hang"] .p-lD{animation:ycp-legA .18s infinite}',
      '[data-state="walk"] .p-lB,[data-state="walk"] .p-lC,',
      '[data-state="climb"] .p-lB,[data-state="climb"] .p-lC,',
      '[data-state="hang"] .p-lB,[data-state="hang"] .p-lC{animation:ycp-legB .18s infinite}',
      '[data-state="chase"] .p-lA,[data-state="chase"] .p-lD{animation:ycp-legA .1s infinite}',
      '[data-state="chase"] .p-lB,[data-state="chase"] .p-lC{animation:ycp-legB .1s infinite}',
      '[data-state="idle"] .p-abd{animation:ycp-breathe 1.6s ease-in-out infinite}',
      '@keyframes ycp-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}',
      '.p-abd{transform-box:fill-box;transform-origin:50% 50%}',

      /* airborne: the thread shows, the legs reach — a descent, not a fall */
      '[data-state="fall"] .p-thread{opacity:.8}',
      '[data-state="fall"] .p-lA,[data-state="fall"] .p-lB{transform:rotate(-16deg)}',
      '[data-state="fall"] .p-lC,[data-state="fall"] .p-lD{transform:rotate(16deg)}',

      /* the gather and the spring */
      '[data-state="crouch"] .p-all{transform:translateY(2px) scaleY(.72) scaleX(1.12)}',
      '[data-state="hop"] .p-lA,[data-state="hop"] .p-lB{transform:rotate(-22deg)}',
      '[data-state="hop"] .p-lC,[data-state="hop"] .p-lD{transform:rotate(22deg)}',
      '[data-state="hop"] .p-all{transform:scaleY(1.08) scaleX(.94)}',

      /* the landing */
      '@keyframes ycp-land{0%{transform:scaleY(.7) scaleX(1.2)}55%{transform:scaleY(1.06) scaleX(.96)}100%{transform:none}}',
      '[data-state="land"] .p-all{animation:ycp-land .2s steps(3,end)}',

      /* carried: dangling on its own silk, mildly patient about it */
      '[data-state="drag"] .p-thread{opacity:.8}',
      '@keyframes ycp-dangle{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(10deg)}}',
      '[data-state="drag"] .p-leg{animation:ycp-dangle .4s ease-in-out infinite}',

      /* idle repertoire */
      '[data-act="rest"] .p-leg{transform:rotate(0)}',
      '[data-act="rest"] .p-all{transform:translateY(1px)}',
      /* spin — the busywork that (sometimes) leaves a web behind */
      '@keyframes ycp-spinL{0%,100%{transform:rotate(-14deg)}25%{transform:rotate(10deg)}50%{transform:rotate(-6deg)}75%{transform:rotate(14deg)}}',
      '[data-act="spin"] .p-lA{animation:ycp-spinL .32s steps(2,end) infinite}',
      '[data-act="spin"] .p-lC{animation:ycp-spinL .32s steps(2,end) infinite .16s}',
      '[data-act="spin"] .p-abd{animation:ycp-breathe .5s ease-in-out infinite}',
      /* twitch — noticed you */
      '@keyframes ycp-rear{0%,100%{transform:rotate(0)}30%,60%{transform:rotate(-9deg) translateY(-.6px)}}',
      '[data-act="twitch"] .p-all{animation:ycp-rear 1.1s steps(3,end) infinite}',
      /* tap — the front legs drum on the ledge */
      '@keyframes ycp-tap{0%,100%{transform:rotate(0)}50%{transform:rotate(13deg)}}',
      '[data-act="tap"] .p-lC{animation:ycp-tap .16s steps(2,end) infinite}',
      '[data-act="tap"] .p-lD{animation:ycp-tap .16s steps(2,end) infinite .08s}',

      /* the webs: anchored on the ledge above the spawn point; the break is
         one sharp snap outward, then gone */
      '.yc-obj-web{margin-left:-15px;margin-top:-26px}',
      '@keyframes ycp-snap{0%{transform:scale(1);opacity:.9}100%{transform:scale(1.3);opacity:0}}',
      '.yc-obj-break svg{animation:ycp-snap .3s ease-out forwards}'
    ]
  });
})();
