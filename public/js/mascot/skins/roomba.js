/* public/js/mascot/skins/roomba.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, ROOMBA FORM — the first capability-masked skin
 *
 * A robot vacuum, and the proof that `can` earns its keep: this skin lists the
 * core states plus chase and NOTHING else, so the engine never climbs it,
 * hangs it, hops it or flies it, the trick panel offers none of those, and
 * what is left is a disc that patrols the floor, chases the cursor at a
 * vacuum's idea of speed, and gets dropped onto the occasional table by a
 * person — from which it can only pace, ponder, and eventually drive off the
 * edge. That is not a missing feature. That is the joke.
 *
 * Flat-disc art rules: greys from Casey-95's plate palette so the two robots
 * read as one product line, one teal LED, and everything at 36×12 — the geom
 * box is the DISC, so the engine's drag point and foot line sit right. The
 * standby dots take the app's muted-text token exactly as the cats' z's do.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'roomba',
    name: 'Roomba',
    blurb: 'Floor only. The ledges are safe; the crumbs are not.',

    // A low disc. FLY_HEAD is moot (no ascent in `can`) but the contract wants
    // the sprite's own height there, so it gets it.
    geom: { W: 36, H: 12, FLY_HEAD: 12 },

    // A vacuum ambles slower than a cat and "chases" the way appliances do:
    // with menaceless determination.
    tune: { WALK: 34, CHASE: 72 },

    // The capability mask this skin exists to prove: the core six, plus chase.
    // No climb, no hang, no hop/crouch, no ascent — the engine enforces it and
    // the panel's button set shrinks to match.
    can: ['walk', 'idle', 'chase', 'fall', 'land', 'drag', 'leave'],

    acts: [
      ['park', 26], ['scan', 20], ['whirr', 18],
      ['standby', 14, { face: 1, dur: [4, 9], cmdDur: [6, 12] }],
      ['wiggle', 12]
    ],

    // When it notices you it scans — no head to turn, so the whole disc does.
    lookAct: 'scan',

    lines: [
      'Sector clean. Billing 0.1 hours.',
      'Obstacle encountered. Obstacle retained.',
      'I have reviewed the floor. It is mine.',
      'Discovery: four crumbs, one staple. Ingested.',
      'Motion practice: forward, reverse, spin.',
      'Edge detected. Objection sustained.',
      'This carpet bills by the fiber.',
      'The ledges are safe. The crumbs are not.',
      'Exhibit A: dust. Exhibit gone.',
      'I do my best work under the couch.',
      'Filed under: the floor. Literally.',
      'Dock? I know no dock. Only duty.',
      'Retainer: one full bin. Weekly.',
      'I am not stuck. I am holding position.',
      'Adjourned. Powering down in place.'
    ],

    words: { idle: 'settle', chase: 'chase me', scan: 'scan about', whirr: 'tidy up' },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 36×12, side view, facing right (the bumper is the front), wheels on the
    // bottom edge. Neutral pose is parked-and-ready, which is the portrait.
    svg:
      '<svg class="v-svg" viewBox="0 0 36 12" width="36" height="12" aria-hidden="true" focusable="false">' +
      '<g class="r2-all">' +
      // wheels first, so the chassis skirt overlaps their tops. Each carries a
      // spoke so the spin reads at this size.
      '<g class="r2-wheel r2-w1">' +
      '<circle cx="9" cy="9.8" r="2.1" fill="#1D2126" stroke="#2F343B" stroke-width=".5"/>' +
      '<path d="M9 8.2 V11.4" stroke="#454C55" stroke-width=".7"/>' +
      '</g>' +
      '<g class="r2-wheel r2-w2">' +
      '<circle cx="26" cy="9.8" r="2.1" fill="#1D2126" stroke="#2F343B" stroke-width=".5"/>' +
      '<path d="M26 8.2 V11.4" stroke="#454C55" stroke-width=".7"/>' +
      '</g>' +
      // the brush box between them, bristles as a dashed line whose dashoffset
      // is the spin
      '<rect x="14" y="8.9" width="7.4" height="2.6" rx="1.3" fill="#23272E"/>' +
      '<path class="r2-bristles" d="M15 10.2 H20.6" stroke="#C6CAD0" stroke-width="1.7" stroke-dasharray="1 1.15"/>' +
      // CHASSIS — one low plate, bevel top, dark skirt, bumper cap at the front
      '<rect class="r2-body" x="1.5" y="1.2" width="33" height="8.2" rx="4" fill="#4A515A" stroke="#2F343B" stroke-width=".7"/>' +
      '<path d="M4 2.3 H31" stroke="#6B7280" stroke-width=".9" stroke-linecap="round"/>' +
      '<path d="M4 8.4 H30" stroke="#343A41" stroke-width=".8" stroke-linecap="round"/>' +
      '<rect x="30.2" y="1.6" width="4.6" height="7.4" rx="2.3" fill="#262B31" stroke="#2F343B" stroke-width=".5"/>' +
      // vents at the rear, buttons amidships, the sensor puck up top
      '<path d="M5.5 4.6 h4.5 M5.5 6.4 h4.5" stroke="#6B7280" stroke-width=".8" stroke-linecap="round"/>' +
      '<circle cx="24.5" cy="4" r="1.1" fill="#8B929B" stroke="#2F343B" stroke-width=".4"/>' +
      '<circle cx="27.4" cy="4" r=".7" fill="#8B929B"/>' +
      '<rect x="13.5" y="-.8" width="9" height="2.6" rx="1.3" fill="#3A4048" stroke="#2F343B" stroke-width=".5"/>' +
      '<circle class="r2-led" cx="18" cy=".5" r=".8" fill="#4FE3C1"/>' +
      // the sonar arcs it scans with, ahead of the bumper; dust it kicks up
      // while tidying, behind. Both hidden until their acts ask.
      '<g class="r2-ping">' +
      '<path d="M37 3.4 q1.6 2.6 0 5.2 M38.8 1.9 q2.6 4.1 0 8.2" fill="none"' +
      ' stroke="#4FE3C1" stroke-width="1.1" stroke-linecap="round"/>' +
      '</g>' +
      '<g class="r2-dust">' +
      '<circle cx="-1.5" cy="10" r="1.3" fill="#9AA1AA"/>' +
      '<circle cx="-3.5" cy="8.6" r="1" fill="#B4BAC2"/>' +
      '<circle cx="-2.6" cy="11.2" r=".9" fill="#A6ADB6"/>' +
      '</g>' +
      '</g>' +
      // STANDBY — two status dots where the cats keep their z's
      '<g class="r2-zzz">' +
      '<circle class="r2-d1" cx="31.5" cy="-2.5" r=".9"/>' +
      '<circle class="r2-d2" cx="33" cy="-5.5" r=".9"/>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // No legs, so the gait is the machinery: bristles scrub, wheels roll, and
    // the disc itself tilts and judders. Stepped where it moves itself (it is
    // an appliance), eased only where physics is doing the moving.
    css: [
      /* pivots: the disc about its bottom centre, each wheel about its hub */
      '.r2-all{transform-origin:18px 12px}',
      '.r2-w1{transform-origin:9px 9.8px}',
      '.r2-w2{transform-origin:26px 9.8px}',
      '.r2-all,.r2-wheel{transition:transform .12s steps(2,end)}',

      /* the LED blinks on a lazy duty cycle; everything else waits for a state */
      '@keyframes ycv-blip{0%,58%{opacity:1}59%,100%{opacity:.16}}',
      '.r2-led{animation:ycv-blip 2.3s steps(1,end) infinite}',
      '.r2-ping,.r2-dust{opacity:0}',

      /* rolling: wheels turn, bristles scrub — the dashoffset IS the brush */
      '@keyframes ycv-roll{to{transform:rotate(360deg)}}',
      '@keyframes ycv-scrub{to{stroke-dashoffset:-4.3}}',
      '[data-state="walk"] .r2-wheel{animation:ycv-roll .55s linear infinite}',
      '[data-state="walk"] .r2-bristles{animation:ycv-scrub .3s linear infinite}',
      /* idling, the brush barely turns over — a vacuum never fully stops caring */
      '[data-state="idle"] .r2-bristles{animation:ycv-scrub 1.2s linear infinite}',
      '[data-state="chase"] .r2-wheel{animation:ycv-roll .3s linear infinite}',
      '[data-state="chase"] .r2-bristles{animation:ycv-scrub .15s linear infinite}',
      '[data-state="chase"] .r2-all{transform:rotate(-2deg)}',   /* front lifts, it means it */

      /* airborne: freewheeling, alarmed */
      '[data-state="fall"] .r2-all{transform:rotate(-7deg)}',
      '[data-state="fall"] .r2-wheel{animation:ycv-roll .25s linear infinite}',
      '[data-state="fall"] .r2-led{fill:#FF6B4A;animation:ycv-blip .18s steps(1,end) infinite}',

      /* the landing clunk */
      '@keyframes ycv-land{0%{transform:scaleY(.7) scaleX(1.15)}55%{transform:scaleY(1.05) scaleX(.97)}100%{transform:none}}',
      '[data-state="land"] .r2-all{animation:ycv-land .22s steps(4,end)}',

      /* carried: it sways, the wheels hunt for a floor that is not there */
      '@keyframes ycv-sway{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(10deg)}}',
      '[data-state="drag"] .r2-all{animation:ycv-sway .5s ease-in-out infinite}',
      '[data-state="drag"] .r2-wheel{animation:ycv-roll .2s linear infinite}',
      '[data-state="drag"] .r2-led{fill:#FF6B4A;animation:ycv-blip .22s steps(1,end) infinite}',

      /* idle repertoire */
      '[data-act="park"] .r2-all{transform:translateY(.6px)}',
      '[data-act="park"] .r2-bristles{animation:none}',
      '[data-act="park"] .r2-led{animation-duration:3.4s}',
      /* scan: the whole disc pivots — it has no head to turn — and pings ahead */
      '@keyframes ycv-scanturn{0%,20%,100%{transform:rotate(0)}40%,60%{transform:rotate(-3deg)}80%{transform:rotate(2.4deg)}}',
      '@keyframes ycv-ping{0%{opacity:0;transform:translateX(-2px)}30%{opacity:.95}100%{opacity:0;transform:translateX(2.5px)}}',
      '[data-act="scan"] .r2-all{animation:ycv-scanturn 3.4s steps(5,end) infinite}',
      '[data-act="scan"] .r2-ping{animation:ycv-ping 1.6s ease-out infinite}',
      /* whirr: flat-out brushing on the spot, kicking dust out the back */
      '@keyframes ycv-judder{0%,100%{transform:translateX(-.5px)}50%{transform:translateX(.5px)}}',
      '@keyframes ycv-puff{0%{opacity:.8;transform:none}100%{opacity:0;transform:translate(-5px,-4px) scale(1.6)}}',
      '[data-act="whirr"] .r2-all{animation:ycv-judder .09s steps(2,end) infinite}',
      '[data-act="whirr"] .r2-bristles{animation:ycv-scrub .1s linear infinite}',
      '[data-act="whirr"] .r2-dust{animation:ycv-puff 1.1s ease-out infinite}',
      /* wiggle: a little celebratory rock on its wheels */
      '@keyframes ycv-wiggle{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}',
      '[data-act="wiggle"] .r2-all{animation:ycv-wiggle .5s steps(2,end) infinite}',
      '[data-act="wiggle"] .r2-wheel{animation:ycv-roll .4s linear infinite}',

      /* standby — settle, breathe, count dots. The dots are muted text over
         the page, so they take the app token, exactly as the cats' z's do. */
      '@keyframes ycv-breathe{0%,100%{opacity:.2}50%{opacity:1}}',
      '@keyframes ycv-z{0%{opacity:0;transform:translate(0,0) scale(.7)}25%{opacity:.9}100%{opacity:0;transform:translate(4px,-9px) scale(1.1)}}',
      '[data-act="standby"] .r2-all{transform:translateY(.8px)}',
      '[data-act="standby"] .r2-bristles{animation:none}',
      '[data-act="standby"] .r2-led{animation:ycv-breathe 1.9s steps(3,end) infinite}',
      '.r2-zzz{opacity:0}',
      '.r2-zzz circle{fill:var(--text-muted);transform-box:fill-box;transform-origin:50% 50%}',
      '[data-act="standby"] .r2-zzz{opacity:1}',
      '[data-act="standby"] .r2-d1{animation:ycv-z 2.6s ease-out infinite}',
      '[data-act="standby"] .r2-d2{animation:ycv-z 2.6s ease-out infinite 1.3s}'
    ]
  });
})();
