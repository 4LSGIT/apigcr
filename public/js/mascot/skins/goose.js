/* public/js/mascot/skins/goose.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, GOOSE FORM — the menace
 *
 * The other rowdy one, and rowdy differently: the spider decorates, the goose
 * TAKES. Upright roaming (side profile, never rotating — a goose keeps its
 * feet) anywhere on the page, tracking mud the whole way; PURSUE at a honking
 * run — no perch in its can, so the catch is the engine's other ending: it
 * pulls up nose-to-cursor and HONKS in its face; and the heist gear, which is
 * the heart of the bit. On a whim (or the 'steal' command) she walks off, IDs
 * something worth having and waddles it back to her corner, where the hoard
 * grows pile by pile. Three kinds of worth having:
 *   · AN ICON off the page — a REAL theft. The icon goes invisible where it
 *     sits and turns up in her corner, and the page has a hole in it until
 *     somebody makes her give it back.
 *   · A WORD off the page — a visual copy, text only; the page keeps its own.
 *   · A PROP from her kit, when the page offers nothing she fancies.
 * The undo is the obvious one: CLICK THE LOOT. A real steal flies home and
 * the icon comes back; a copy just stops existing. Everything she drops is
 * still on the never-clickable contract — the click is a coordinate test, so
 * it reaches the page underneath too — and send-her-away works instantly
 * mid-anything, returning every stolen thing on the way out.
 *
 * Clumsy, entitled, unrepentant. She is not sorry. She was never sorry.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'goose',
    name: 'Goose',
    blurb: 'A goose. Tracks mud, honks at your cursor, and steals words and icons off the page for her corner hoard. Click her loot to get it back. Rowdy.',

    // Tall for the neck. No ascent in `can`, so FLY_HEAD is the sprite's own
    // height per the contract's convention.
    geom: { W: 34, H: 30, FLY_HEAD: 30 },

    roam: true,
    upright: true,

    tune: {
      WALK: 55,              // a committed waddle
      PURSUE: 150,           // the honking run — outrun it, mostly, barely
      PURSUE_CHANCE: 0.4,
      HEIST_CHANCE: 0.4      // she is mostly here to acquire
    },

    // The upright-roam set plus the hunt. No perch: her catch is the honk.
    can: ['walk', 'idle', 'fall', 'land', 'drag', 'leave', 'pursue'],

    acts: [
      ['honk', 30], ['glare', 22], ['preen', 22], ['flap', 18]
    ],

    // When it notices you. Obviously.
    lookAct: 'honk',

    lines: [
      'HONK.',
      'Everything here is mine. I checked.',
      'I am the trustee now. Assets to the corner.',
      'Possession is nine-tenths. I hold the other tenth too.',
      'I have reviewed your filing. It is mine now.',
      'That word was just lying there.',
      'The hoard is not up for negotiation.',
      'Muddy prints are my letterhead.',
      'Objection! HONK.',
      'Your cursor owes me a honk.',
      'I do my best work uninvited.',
      'Nice case file. Shame if it waddled off.',
      'The pond ruled in my favour.',
      'Chapter 7 me all you like — the corner is exempt.',
      'Adjourned. HONK.'
    ],

    words: {
      idle: 'settle', pursue: 'chase down my cursor', steal: 'steal something',
      honk: 'HONK', glare: 'glare', preen: 'preen', flap: 'flap about'
    },

    // The letterhead: webbed prints, alternating, gone in a few seconds.
    trail: {
      every: 16,
      life: 9,
      max: 30,
      svg: '<svg width="12" height="9" viewBox="0 0 12 9">' +
        '<g fill="#8B6B4A" opacity=".5">' +
        '<path d="M1.6 1 L5 1 L3.3 4.4 Z M2.2 1.4 L3.3 3.4 M4.4 1.4 L3.3 3.4" stroke="#7A5C3E" stroke-width=".4"/>' +
        '<path d="M7 4.5 L10.4 4.5 L8.7 7.9 Z M7.6 4.9 L8.7 6.9 M9.8 4.9 L8.7 6.9" stroke="#7A5C3E" stroke-width=".4"/>' +
        '</g></svg>'
    },

    // The kit. Props are things an office simply has, until it simply doesn't.
    heist: {
      props: [
        // an envelope
        '<svg width="18" height="12" viewBox="0 0 18 12">' +
        '<rect x=".5" y=".5" width="17" height="11" rx="1" fill="#F7F3E8" stroke="#8A8272" stroke-width=".7"/>' +
        '<path d="M.5 1.2 L9 7 L17.5 1.2" fill="none" stroke="#8A8272" stroke-width=".7"/></svg>',
        // a pencil
        '<svg width="20" height="9" viewBox="0 0 20 9"><g transform="rotate(-8 10 4.5)">' +
        '<rect x="2" y="3" width="13" height="3" fill="#F2C14E" stroke="#A8862F" stroke-width=".5"/>' +
        '<path d="M15 3 L18.5 4.5 L15 6 Z" fill="#E8D5B5" stroke="#A8862F" stroke-width=".5"/>' +
        '<path d="M17 3.9 L18.5 4.5 L17 5.1 Z" fill="#3A3F4A"/>' +
        '<rect x=".4" y="3" width="1.8" height="3" fill="#E88A8A" stroke="#A8862F" stroke-width=".5"/></g></svg>',
        // a sticky note
        '<svg width="14" height="14" viewBox="0 0 14 14">' +
        '<path d="M1 1 H13 V10 L10 13 H1 Z" fill="#F9E97A" stroke="#C9B93F" stroke-width=".6"/>' +
        '<path d="M13 10 L10 10 L10 13" fill="#EAD44F" stroke="#C9B93F" stroke-width=".6"/>' +
        '<path d="M3 4.5 H11 M3 7 H9.5" stroke="#B3A63C" stroke-width=".7" fill="none"/></svg>',
        // a paperclip
        '<svg width="9" height="16" viewBox="0 0 9 16">' +
        '<path d="M4.5 2 A2 2 0 0 1 6.5 4 V12 A1.7 1.7 0 0 1 3.1 12 V5.2 A1.1 1.1 0 0 1 5.3 5.2 V11"' +
        ' fill="none" stroke="#8C97A8" stroke-width="1" stroke-linecap="round"/></svg>'
      ]
    },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 34×30, side profile facing right, feet on the bottom edge. The NECK is
    // the whole performance — hinged at its base, it bobs on the waddle,
    // stretches flat for the charge, cranes for the honk and swings back for
    // the preen. The honk marks (.g-shout) ship hidden; honk shows them.
    svg:
      '<svg class="g-svg" viewBox="0 0 34 30" width="34" height="30" aria-hidden="true" focusable="false">' +
      '<g class="g-all">' +
      // legs first, so the body sits over the hips
      '<g class="g-legB">' +
      '<path d="M14 21.5 L13.4 27.5" stroke="#E8850C" stroke-width="1.5" stroke-linecap="round" fill="none"/>' +
      '<path d="M11.2 29 L13.4 27.2 L15.4 29 Z" fill="#E8850C" stroke="#B5680A" stroke-width=".5" stroke-linejoin="round"/>' +
      '</g>' +
      '<g class="g-legF">' +
      '<path d="M19 21.5 L19.4 27.5" stroke="#F09A28" stroke-width="1.5" stroke-linecap="round" fill="none"/>' +
      '<path d="M17.2 29 L19.4 27.2 L21.4 29 Z" fill="#F09A28" stroke="#B5680A" stroke-width=".5" stroke-linejoin="round"/>' +
      '</g>' +
      // the body: plump, stern-heavy, tail kicked up aft
      '<g class="g-body">' +
      '<path d="M5.2 13.6 L7.6 16.4 C7.2 20.6 10.6 22.8 15.4 22.8 C20.4 22.8 24 20.6 24.4 16.8' +
      ' C24.6 14.4 22.8 12.6 19.8 12.4 L10 12.8 C7.6 12.9 6 13.1 5.2 13.6 Z"' +
      ' fill="#F2F0EA" stroke="#5A5348" stroke-width=".7" stroke-linejoin="round"/>' +
      '<path d="M5.2 13.6 L7.6 16.4" fill="none" stroke="#5A5348" stroke-width=".7"/>' +      /* tail notch */
      '<path d="M9.4 21.4 q3.4 1.6 8 .6" fill="none" stroke="#D9D4C8" stroke-width=".9" stroke-linecap="round"/>' +
      '</g>' +
      // the wing, folded along the flank; it lifts and beats on its shoulder
      '<g class="g-wing">' +
      '<path d="M9.2 14.2 C7.8 16.8 9.4 19.6 12.6 20.2 C16 20.8 19.6 19.6 21.4 17' +
      ' C19.4 17.8 18 17.6 16.4 16.6 C13.6 18 11 17.4 9.2 14.2 Z"' +
      ' fill="#E4E0D4" stroke="#5A5348" stroke-width=".6" stroke-linejoin="round"/>' +
      '</g>' +
      // THE NECK: two strokes (outline under, fill over), head and hardware
      '<g class="g-neck">' +
      '<path class="g-nck1" d="M20.6 15.6 C23.6 14.6 24.6 11.4 24.6 6.6" fill="none" stroke="#5A5348" stroke-width="4.6" stroke-linecap="round"/>' +
      '<path class="g-nck2" d="M20.6 15.6 C23.6 14.6 24.6 11.4 24.6 6.6" fill="none" stroke="#F2F0EA" stroke-width="3.4" stroke-linecap="round"/>' +
      '<ellipse cx="25.2" cy="5.4" rx="3.4" ry="2.9" fill="#F2F0EA" stroke="#5A5348" stroke-width=".7"/>' +
      // the beak, two mandibles so the honk can open it
      '<path class="g-beakT" d="M28.2 4.6 L33.2 5.6 L28.4 6.2 Z" fill="#E8850C" stroke="#B5680A" stroke-width=".5" stroke-linejoin="round"/>' +
      '<path class="g-beakB" d="M28.3 6.2 L32.2 6.4 L28.5 7.3 Z" fill="#D9790B" stroke="#B5680A" stroke-width=".5" stroke-linejoin="round"/>' +
      // the eye: small, black, utterly without mercy
      '<circle class="g-eye" cx="26.2" cy="4.4" r=".85" fill="#26221C"/>' +
      '<circle cx="26.5" cy="4.1" r=".25" fill="#FFFFFF"/>' +
      // honk marks, hidden until the act
      '<g class="g-shout">' +
      '<path d="M33.6 3.4 l1.6 -1.2 M34.4 5.8 l2 0 M33.6 8 l1.6 1.2"' +
      ' stroke="#C9412B" stroke-width=".9" stroke-linecap="round" fill="none"/>' +
      '</g>' +
      '</g>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // The engine drives position and facing; the css supplies the waddle, the
    // charge and the temper. The neck group is where the acting happens.
    css: [
      '.g-all{transform-origin:17px 15px;transition:transform .18s ease}',
      '.g-body,.g-wing{transform-origin:15px 17px;transition:transform .18s ease}',
      '.g-neck{transform-origin:21px 15.5px;transition:transform .22s ease}',
      '.g-legB{transform-origin:14px 21.5px}.g-legF{transform-origin:19px 21.5px}',
      '.g-legB,.g-legF{transition:transform .15s ease}',
      '.g-beakT,.g-beakB{transform-origin:28.3px 6px;transition:transform .12s ease}',
      '.g-eye{transform-box:fill-box;transform-origin:50% 50%;transition:transform .2s ease}',
      '.g-shout{opacity:0}',

      /* the waddle: body rocks, hips alternate, neck bobs a half-beat behind */
      '@keyframes ycg-rock{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}',
      '@keyframes ycg-stepB{0%,100%{transform:rotate(-22deg)}50%{transform:rotate(18deg)}}',
      '@keyframes ycg-stepF{0%,100%{transform:rotate(18deg)}50%{transform:rotate(-22deg)}}',
      '@keyframes ycg-bob{0%,100%{transform:rotate(4deg)}50%{transform:rotate(-4deg)}}',
      '[data-state="walk"] .g-body,[data-state="walk"] .g-wing{animation:ycg-rock .46s ease-in-out infinite}',
      '[data-state="walk"] .g-legB{animation:ycg-stepB .46s ease-in-out infinite}',
      '[data-state="walk"] .g-legF{animation:ycg-stepF .46s ease-in-out infinite}',
      '[data-state="walk"] .g-neck{animation:ycg-bob .46s ease-in-out infinite .06s}',

      /* idle: the slow periscope sweep of something choosing its next victim */
      '@keyframes ycg-scan{0%,100%{transform:rotate(2deg)}40%{transform:rotate(-5deg)}70%{transform:rotate(3deg)}}',
      '@keyframes ycg-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.015)}}',
      '[data-state="idle"] .g-neck{animation:ycg-scan 4.6s ease-in-out infinite}',
      '[data-state="idle"] .g-body{animation:ycg-breathe 2.4s ease-in-out infinite}',

      /* THE CHARGE: neck flat out ahead, wing beating, legs at full sprint —
         the engine supplies the speed and the wobble, this supplies the rage */
      '@keyframes ycg-sprintB{0%,100%{transform:rotate(-32deg)}50%{transform:rotate(26deg)}}',
      '@keyframes ycg-sprintF{0%,100%{transform:rotate(26deg)}50%{transform:rotate(-32deg)}}',
      '@keyframes ycg-beat{0%,100%{transform:rotate(-24deg) translateY(-1px)}50%{transform:rotate(10deg)}}',
      '[data-state="pursue"] .g-all{transform:rotate(6deg)}',
      '[data-state="pursue"] .g-neck{transform:rotate(34deg)}',
      '[data-state="pursue"] .g-wing{animation:ycg-beat .15s linear infinite}',
      '[data-state="pursue"] .g-legB{animation:ycg-sprintB .2s linear infinite}',
      '[data-state="pursue"] .g-legF{animation:ycg-sprintF .2s linear infinite}',

      /* thrown: no dignity retained — legs splayed, wing flailing, neck loose */
      '@keyframes ycg-flail{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(9deg)}}',
      '[data-state="fall"] .g-legB{transform:rotate(-38deg)}',
      '[data-state="fall"] .g-legF{transform:rotate(38deg)}',
      '[data-state="fall"] .g-wing{animation:ycg-beat .1s linear infinite}',
      '[data-state="fall"] .g-neck{animation:ycg-flail .16s linear infinite}',

      /* the landing */
      '@keyframes ycg-land{0%{transform:scaleY(.8) scaleX(1.1)}60%{transform:scaleY(1.05) scaleX(.97)}100%{transform:none}}',
      '[data-state="land"] .g-all{animation:ycg-land .22s ease-out}',

      /* carried: paddling on principle, craning to bite the hand */
      '@keyframes ycg-paddleB{0%,100%{transform:rotate(-30deg)}50%{transform:rotate(24deg)}}',
      '@keyframes ycg-paddleF{0%,100%{transform:rotate(24deg)}50%{transform:rotate(-30deg)}}',
      '[data-state="drag"] .g-legB{animation:ycg-paddleB .16s linear infinite}',
      '[data-state="drag"] .g-legF{animation:ycg-paddleF .16s linear infinite}',
      '[data-state="drag"] .g-neck{transform:rotate(-14deg)}',
      '[data-state="drag"] .g-beakT{transform:rotate(-10deg)}',

      /* mid-heist: the neck carries the loot high. Not proudly. Fine: proudly. */
      '[data-carry="1"] .g-neck{transform:rotate(-6deg)}',
      '[data-carry="1"] .g-beakB{transform:rotate(6deg)}',

      /* idle repertoire */
      /* honk — the full mechanism: coil, THRUST, beak wide, marks out */
      '@keyframes ycg-honk{0%,100%{transform:rotate(2deg)}18%{transform:rotate(-10deg)}38%,72%{transform:rotate(26deg) translate(1px,0)}}',
      '@keyframes ycg-gape{0%,15%,90%,100%{transform:rotate(0)}30%,70%{transform:rotate(-16deg)}}',
      '@keyframes ycg-gapeB{0%,15%,90%,100%{transform:rotate(0)}30%,70%{transform:rotate(12deg)}}',
      '@keyframes ycg-marks{0%,20%{opacity:0}35%,70%{opacity:1}100%{opacity:0}}',
      '[data-act="honk"] .g-neck{animation:ycg-honk 1.5s ease-in-out infinite}',
      '[data-act="honk"] .g-beakT{animation:ycg-gape 1.5s ease-in-out infinite}',
      '[data-act="honk"] .g-beakB{animation:ycg-gapeB 1.5s ease-in-out infinite}',
      '[data-act="honk"] .g-shout{animation:ycg-marks 1.5s ease-in-out infinite}',
      /* glare — neck lowered level, eye narrowed. The pre-honk silence. */
      '[data-act="glare"] .g-neck{transform:rotate(30deg)}',
      '[data-act="glare"] .g-eye{transform:scaleY(.4)}',
      /* preen — head buried in the wing, wing risen to meet it */
      '[data-act="preen"] .g-neck{transform:rotate(-52deg)}',
      '[data-act="preen"] .g-wing{transform:rotate(-8deg) translateY(-1px)}',
      /* flap — the territorial stretch: chest out, wing at full beat */
      '@keyframes ycg-bigbeat{0%,100%{transform:rotate(-30deg) translateY(-2px) scale(1.15)}50%{transform:rotate(8deg) scale(1.05)}}',
      '[data-act="flap"] .g-wing{animation:ycg-bigbeat .5s ease-in-out infinite}',
      '[data-act="flap"] .g-body{transform:rotate(-4deg)}',
      '[data-act="flap"] .g-neck{transform:rotate(-8deg)}',

      /* the letterhead, dropped from the body centre down to the feet */
      '.yc-obj-trail{margin-left:-6px;margin-top:8px}',

      /* THE HOARD. Loot is centred on where she dropped it and sits at a
         careless angle, because she did not set it down so much as let go. */
      '.yc-obj-loot{margin-left:-9px;margin-top:-9px;transform-origin:50% 50%}',
      '.yc-obj-loot>*{display:inline-block;transform:rotate(-7deg)}',
      '.yc-obj-loot:nth-child(2n)>*{transform:rotate(9deg)}',
      '.yc-obj-loot:nth-child(3n)>*{transform:rotate(-3deg)}',

      /* Given back. The engine flies a REAL steal home and owns its transform,
         so this side only fades — otherwise the two would fight. */
      '.yc-obj-return{filter:drop-shadow(0 0 4px rgba(255,255,255,.7))}',
      /* A copy was never anywhere: it just stops being. This one is all ours. */
      '@keyframes ycg-poof{0%{transform:scale(1) rotate(0);opacity:.95}' +
      '55%{transform:scale(1.35) rotate(-6deg);opacity:.5}' +
      '100%{transform:scale(.4) rotate(6deg);opacity:0}}',
      '.yc-obj-poof>*{animation:ycg-poof .4s ease-out forwards}'
    ]
  });
})();
