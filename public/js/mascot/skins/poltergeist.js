/* public/js/mascot/skins/poltergeist.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, POLTERGEIST FORM — the loud one
 *
 * Mark II. The first attempt was a blue ghost that tilted things politely, and
 * it was neither: it read as the ghost with the lights off, and a three-degree
 * lean is a prank rather than chaos. So:
 *
 *   · IT IS A JESTER. Not a bedsheet — a cap with bells, a grin with too many
 *     teeth, two little arms and a crooked stare. The ghost is a shy thing
 *     under a sheet; this is the one at the back of the room throwing the
 *     furniture. You can tell them apart in the picker now.
 *   · IT WRECKS THINGS PROPERLY. The haunt got violent: the thing RATTLES
 *     before it settles, and it can end up mirrored or flat upside down
 *     rather than merely leaning. Five at once instead of three.
 *   · IT WRITES ON YOUR SCREEN. The graffiti gear — big scrawled words across
 *     your work, drawn on left to right as though somebody were writing them.
 *
 * Every bit of it comes back. The tilt rights itself, the scrawl rubs out —
 * on their own clocks, the moment you press them, or the instant the pet is
 * grabbed or sent away. Nothing it leaves can take a click. That is the deal
 * this whole arc makes with §2, and the loudest form keeps it exactly.
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
    blurb: 'Scrawls on your screen and knocks things crooked, and never stops. Right-click to undo.',

    geom: { W: 32, H: 38, FLY_HEAD: 38 },

    tune: {
      GRAVITY: 260,          // when it does fall, it falls like a rumour
      TERMINAL: 130,
      WALK: 26,
      DRIFT_CHANCE: 0.7,     // it barely touches the floor
      BLINK_MS: 0.34,
      HAUNT_CHANCE: 0.6,
      GRAFFITI_CHANCE: 0.5
    },

    // The noclip set. No climb, no hang, no chase — it does not need to reach
    // you, it only needs to reach your furniture.
    can: ['walk', 'idle', 'fall', 'land', 'drag', 'leave', 'drift', 'blink'],

    // The vandalism kit. Poses are BIG now: a mirrored row or an upside-down
    // heading is the point. They are still transforms, so everything stays
    // clickable exactly where it looks, and a press puts it right.
    haunt: {
      // NOTHING IT DOES EXPIRES. Left alone it keeps going until the screen
      // is a wreck; the ceiling only decides how big a wreck, because at the
      // cap the oldest thing straightens up to make room for the next. The
      // way out is a right-click, which is always there and never misfires.
      max: 14,
      life: 0,
      sel: 'button,.card,.big-button,tr,th,h1,h2,h3,img,.panel,.tile,label',
      poses: [
        'rotate(-8deg)',
        'rotate(7deg)',
        'rotate(180deg)',                    // flat upside down
        'scaleX(-1)',                        // mirrored, which is worse
        'translateY(-12px) rotate(4deg)',
        'translateX(14px) rotate(-5deg)',
        'skewY(-6deg)',
        'scale(1.12) rotate(-6deg)',
        'rotate(3deg) scaleY(-1)'
      ]
    },

    // The loud one. Short, legible, and plainly the pet rather than the app.
    graffiti: {
      max: 9,
      life: 0,               // stays until it is rubbed out
      texts: [
        'BOO', 'MINE NOW', 'OBJECTION', 'WONKY', 'I WAS HERE',
        'ADJOURNED', 'TILT', 'NICE DESK', 'SO DUSTY', 'RUDE'
      ],
      // The engine picks the word, the spot and the angle; the hand is ours.
      // The svg centres ITSELF on the drop point — the object layer positions
      // by top-left and cannot know how wide a given word came out.
      svg: function (CFG, text, tilt, w, h) {
        // The reveal clips to this element's box, so the box has to be bigger
        // than the writing or the clip eats the ends of the word — a tilted
        // line of 58px script needs real margin at both ends. Pad the canvas
        // rather than shrinking the joke.
        var cw = w * 1.3, ch = h * 1.25;
        var size = Math.min(46, Math.max(22, w / Math.max(3, text.length * 0.58)));
        var safe = String(text).replace(/[&<>]/g, '');
        return '<svg width="' + cw.toFixed(0) + '" height="' + ch.toFixed(0) + '"' +
          ' viewBox="0 0 ' + cw.toFixed(0) + ' ' + ch.toFixed(0) + '"' +
          ' style="display:block;margin-left:' + (-cw / 2).toFixed(0) + 'px;margin-top:' + (-ch / 2).toFixed(0) + 'px">' +
          '<text class="pg-scrawl" x="' + (cw / 2).toFixed(0) + '" y="' + (ch * 0.62).toFixed(0) + '"' +
          ' text-anchor="middle" font-size="' + size.toFixed(1) + '"' +
          ' transform="rotate(' + tilt.toFixed(1) + ' ' + (cw / 2).toFixed(0) + ' ' + (ch / 2).toFixed(0) + ')">' +
          safe + '</text></svg>';
      }
    },

    acts: [
      ['cackle', 28], ['loom', 22], ['stare', 22], ['juggle', 20]
    ],

    // When it notices you it does not go quiet. It gets louder.
    lookAct: 'cackle',

    lines: [
      'I did not move it. It was always like that.',
      'Your furniture has opinions now.',
      'I file under duress. And at an angle.',
      'Objection: the table leaned first.',
      'Nothing here is level. You are welcome.',
      'I am a draught with standing.',
      'Straighten it. I will wait. I will do it again.',
      'The estate includes the crooked parts.',
      'I have no body and I must file.',
      'Every office has one. Yours has me.',
      'Tilt is a lifestyle.',
      'I audited your alignment. It failed.',
      'Press it and it stands up. Sad, really.',
      'I signed your screen. No charge.',
      'Adjourned. Something behind you is wrong.'
    ],

    words: {
      idle: 'settle', drift: 'seep about', blink: 'flicker',
      haunt: 'knock something crooked', scrawl: 'write on my screen',
      // (both undone by a right-click on the thing itself)
      cackle: 'cackle', loom: 'loom', stare: 'stare', juggle: 'juggle'
    },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 32×38, facing +x. A JESTER, not a bedsheet, told by two things: the
    // CAP (the most saturated thing in the file, because colour is what
    // separates it from the ghost at portrait size) and the TAIL — it tapers
    // to a hooked curl like something poured out of a bottle, where a ghost
    // ends in a wavy flat hem. Two stubby arms, because a poltergeist
    // gestures at what it has just ruined.
    svg:
      '<svg class="pg-svg" viewBox="0 0 32 38" width="32" height="38" aria-hidden="true" focusable="false">' +
      '<defs>' +
      '<radialGradient id="pgBody" cx="50%" cy="38%" r="66%">' +
      '<stop offset="0%" stop-color="#E4F0FF" stop-opacity=".97"/>' +
      '<stop offset="58%" stop-color="#9FBEE4" stop-opacity=".93"/>' +
      '<stop offset="100%" stop-color="#6A8CBC" stop-opacity=".85"/>' +
      '</radialGradient>' +
      '</defs>' +
      '<g class="pg-all">' +

      // ── the body: a GENIE TAIL, not a hem ────────────────────────────────
      // This is the silhouette difference. A ghost ends in a wavy flat hem
      // and reads as a sheet with something under it; this narrows from the
      // shoulders into a single tapering tail that hooks round on itself,
      // like something being poured out of a bottle. Nothing about it touches
      // the floor, which is the other half of the impression.
      '<g class="pg-veil">' +
      '<path class="pg-body" d="M16 9.6' +
      ' C22.6 9.6 26.3 14.5 26.2 20.8' +           /* right shoulder, down */
      ' C26.1 24.6 25.2 27.6 23.4 30.2' +          /* right flank drawing in */
      ' C21.8 32.5 20 34.4 18.2 35.8' +            /* the taper */
      ' C16.6 37.1 14.8 37.9 13.3 37.4' +          /* out to the tip */
      ' C11.8 36.9 11.3 35.2 12.3 34.1' +          /* the hook turns under */
      ' C13.2 33.1 14.8 33.3 15.3 34.4' +          /* …and curls back up */
      ' C15.6 35.1 15.3 35.8 14.7 36' +            /* the little inner return */
      ' C15.9 35.4 17 34.2 17.6 32.6' +            /* inside edge, climbing */
      ' C15.6 32.2 13.2 30.6 11.7 28.2' +
      ' C10.3 26 9.7 23.4 9.8 20.8' +
      ' C9.9 14.5 9.4 9.6 16 9.6 Z"' +
      ' fill="url(#pgBody)" stroke="#456E9B" stroke-width=".7" stroke-linejoin="round"/>' +
      // the two little arms
      // kept a stroke-width clear of the viewBox edges: an svg clips at its
      // own box by default, and at 3.2 wide a tip at x=31.2 loses its cap
      '<path class="pg-armL" d="M10 20.4 C7 19.9 5.4 21.4 4.9 23.4" fill="none"' +
      ' stroke="#9FBEE4" stroke-width="3.2" stroke-linecap="round"/>' +
      '<path class="pg-armR" d="M25.4 20.4 C28.4 19.9 30 21.4 30.5 23.4" fill="none"' +
      ' stroke="#9FBEE4" stroke-width="3.2" stroke-linecap="round"/>' +
      '</g>' +

      // ── the face: crooked, delighted, too many teeth ──────────────────────
      '<g class="pg-face">' +
      // the eyes do not match, which is most of the personality
      '<ellipse class="pg-eyeL" cx="12.6" cy="18.6" rx="2.3" ry="2.8" fill="#241C33"/>' +
      '<ellipse class="pg-eyeR" cx="19.6" cy="18.2" rx="1.5" ry="2.2" fill="#241C33"/>' +
      '<circle cx="13.3" cy="17.7" r=".72" fill="#FFFFFF"/>' +
      '<circle cx="20.1" cy="17.4" r=".5" fill="#FFFFFF"/>' +
      // brows, one up one down
      '<path d="M10 15 q2.6 -1.6 5.2 -.5" fill="none" stroke="#3E5C82" stroke-width=".85" stroke-linecap="round"/>' +
      '<path d="M17.8 14.2 q2.4 .3 4 1.7" fill="none" stroke="#3E5C82" stroke-width=".85" stroke-linecap="round"/>' +
      // THE GRIN
      '<path class="pg-grin" d="M10.6 24.2 C13.6 29.2 19.4 29.2 22.2 24.4 Z" fill="#241C33"/>' +
      '<path d="M12.6 25.6 l1.5 2.2 l1.4 -2.2 Z M16.2 25.7 l1.4 2.3 l1.4 -2.3 Z"' +
      ' fill="#FFFFFF" opacity=".92"/>' +
      '<path d="M11 24.3 q5.6 -1 10.8 .1" fill="none" stroke="#FFFFFF" stroke-width=".8" opacity=".85"/>' +
      '</g>' +

      // ── THE CAP — the reason you can tell it from the ghost ───────────────
      '<g class="pg-cap">' +
      // left horn, flopping forward
      '<g class="pg-hornL">' +
      '<path d="M13.6 9.6 C10 8.6 6.2 6.2 4.4 2.6 C7.8 1.6 11.6 3.6 14 6.8 Z"' +
      ' fill="#6B3FA0" stroke="#4A2A72" stroke-width=".6" stroke-linejoin="round"/>' +
      '<circle cx="4.2" cy="2.4" r="2.1" fill="#F2C94C" stroke="#A9821B" stroke-width=".6"/>' +
      '<path d="M3.1 2.1 q1.1 .9 2.2 0" fill="none" stroke="#A9821B" stroke-width=".5"/>' +
      '</g>' +
      // right horn, flopping back
      '<g class="pg-hornR">' +
      '<path d="M18.4 9.6 C22 8.4 25.6 6.6 28 3.2 C24.8 1.8 20.8 3.4 18.2 6.6 Z"' +
      ' fill="#E0A21A" stroke="#A9741B" stroke-width=".6" stroke-linejoin="round"/>' +
      '<circle cx="28.2" cy="3" r="2.1" fill="#F2C94C" stroke="#A9821B" stroke-width=".6"/>' +
      '<path d="M27.1 2.7 q1.1 .9 2.2 0" fill="none" stroke="#A9821B" stroke-width=".5"/>' +
      '</g>' +
      // the band across the brow, in both colours
      '<path d="M8.6 11.4 C10.4 8.4 21.6 8.4 23.4 11.4 C21.6 12.9 10.4 12.9 8.6 11.4 Z"' +
      ' fill="#6B3FA0" stroke="#4A2A72" stroke-width=".6" stroke-linejoin="round"/>' +
      '<path d="M16 9.5 C19.6 9.5 22.4 10.2 23.4 11.4 C22.4 12.2 19.4 12.7 16 12.75 Z" fill="#E0A21A"/>' +
      '</g>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    css: [
      // the blink fade rides the skin's own root group, as the ghost's does
      '.pg-all{transform-origin:16px 22px;transition:transform .3s ease,opacity .34s ease}',
      '.pg-veil{transform-box:fill-box;transform-origin:50% 50%}',
      '.pg-face{transform-origin:16px 21px;transition:transform .25s ease}',
      '.pg-cap{transform-origin:16px 11px;transition:transform .25s ease}',
      '.pg-hornL{transform-origin:13.6px 9.6px}.pg-hornR{transform-origin:18.4px 9.6px}',
      '.pg-armL{transform-origin:10px 20.4px}.pg-armR{transform-origin:25.4px 20.4px}',
      '.pg-armL,.pg-armR{transition:transform .2s ease}',

      /* the bells never quite settle */
      '@keyframes ycpg-hornL{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(7deg)}}',
      '@keyframes ycpg-hornR{0%,100%{transform:rotate(5deg)}50%{transform:rotate(-7deg)}}',
      '.pg-hornL{animation:ycpg-hornL 1.7s ease-in-out infinite}',
      '.pg-hornR{animation:ycpg-hornR 2.1s ease-in-out infinite}',
      /* and the sheet ripples under it */
      '@keyframes ycpg-ripple{0%,100%{transform:scale(1) translateY(0)}50%{transform:scale(1.03,.98) translateY(-.6px)}}',
      '.pg-veil{animation:ycpg-ripple 2.6s ease-in-out infinite}',

      /* seeping about: it leans into the travel, arms trailing */
      '[data-state="drift"] .pg-all{transform:rotate(-3deg)}',
      '[data-state="drift"] .pg-armL{transform:rotate(26deg)}',
      '[data-state="drift"] .pg-armR{transform:rotate(-26deg)}',

      /* the floor, which it resents */
      '@keyframes ycpg-trudge{0%,100%{transform:translateY(0)}50%{transform:translateY(1.4px)}}',
      '[data-state="walk"] .pg-all{animation:ycpg-trudge .85s ease-in-out infinite}',
      '[data-state="idle"] .pg-all{transform:scaleY(.99)}',

      /* falling: arms up, cap streaming, delighted */
      '[data-state="fall"] .pg-armL{transform:rotate(-58deg)}',
      '[data-state="fall"] .pg-armR{transform:rotate(58deg)}',
      '[data-state="fall"] .pg-cap{transform:rotate(-8deg) translateY(1px)}',
      '@keyframes ycpg-land{0%{transform:scaleY(.8) scaleX(1.14)}60%{transform:scaleY(1.05) scaleX(.97)}100%{transform:none}}',
      '[data-state="land"] .pg-all{animation:ycpg-land .3s ease-out}',

      /* the dissolve */
      '[data-state="blink"] .pg-all{opacity:0;transform:scale(1.25)}',
      '[data-state="blink"] .pg-face{transform:scale(.5)}',

      /* carried: it does not struggle. It waves. */
      '@keyframes ycpg-wave{0%,100%{transform:rotate(-40deg)}50%{transform:rotate(-70deg)}}',
      '[data-state="drag"] .pg-armR{animation:ycpg-wave .5s ease-in-out infinite}',
      '[data-state="drag"] .pg-all{transform:scaleY(1.06)}',

      /* idle repertoire */
      /* cackle — the whole thing bounces and the grin goes wide */
      '@keyframes ycpg-cackle{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-3px) rotate(2deg)}}',
      '@keyframes ycpg-grin{0%,100%{transform:scale(1)}50%{transform:scale(1.14,1.22)}}',
      '[data-act="cackle"] .pg-all{animation:ycpg-cackle .34s ease-in-out infinite}',
      '[data-act="cackle"] .pg-grin{transform-box:fill-box;transform-origin:50% 0;animation:ycpg-grin .34s ease-in-out infinite}',
      '[data-act="cackle"] .pg-hornL{animation:ycpg-hornL .3s ease-in-out infinite}',
      '[data-act="cackle"] .pg-hornR{animation:ycpg-hornR .26s ease-in-out infinite}',
      /* loom — it gets bigger. That is the whole act. */
      '@keyframes ycpg-loom{0%,100%{transform:scale(1)}55%{transform:scale(1.16) translateY(-2px)}}',
      '[data-act="loom"] .pg-all{animation:ycpg-loom 3.4s ease-in-out infinite}',
      '[data-act="loom"] .pg-armL{transform:rotate(-44deg)}',
      '[data-act="loom"] .pg-armR{transform:rotate(44deg)}',
      /* stare — everything stops except the eyes, which slide */
      '@keyframes ycpg-fix{0%,100%{transform:translateX(-1px)}50%{transform:translateX(1px)}}',
      '[data-act="stare"] .pg-face{animation:ycpg-fix 2.6s ease-in-out infinite}',
      '[data-act="stare"] .pg-veil{animation-duration:6s}',
      /* juggle — the arms work something invisible, badly */
      '@keyframes ycpg-jugL{0%,100%{transform:rotate(-30deg)}50%{transform:rotate(18deg)}}',
      '@keyframes ycpg-jugR{0%,100%{transform:rotate(30deg)}50%{transform:rotate(-18deg)}}',
      '[data-act="juggle"] .pg-armL{animation:ycpg-jugL .3s ease-in-out infinite}',
      '[data-act="juggle"] .pg-armR{animation:ycpg-jugR .3s ease-in-out infinite .15s}',
      '[data-act="juggle"] .pg-cap{transform:rotate(3deg)}',

      /* ── what it does to your page ────────────────────────────────────── */
      /* THE RATTLE. The engine's inline transform is the pose the thing
         settles INTO; this shakes it to bits first and then lets go, which is
         the whole difference between a tilt and a haunting. */
      '@keyframes ycpg-rattle{0%,100%{transform:translate(0,0) rotate(0)}' +
      '12%{transform:translate(-3px,2px) rotate(-2.5deg)}' +
      '26%{transform:translate(3px,-2px) rotate(2.5deg)}' +
      '40%{transform:translate(-2px,-2px) rotate(-1.8deg)}' +
      '56%{transform:translate(2px,2px) rotate(1.8deg)}' +
      '72%{transform:translate(-1px,1px) rotate(-1deg)}' +
      '88%{transform:translate(1px,-1px) rotate(.6deg)}}',
      '.yc-haunted{animation:ycpg-rattle .5s linear;filter:drop-shadow(0 0 7px rgba(150,120,220,.5))}',

      /* THE SCRAWL: written on, left to right, in a hand that is enjoying it */
      '.yc-obj-graffiti .pg-scrawl{font-family:"Segoe Script","Bradley Hand","Comic Sans MS",cursive;' +
      'font-weight:700;fill:#D0402A;stroke:#6E1C10;stroke-width:1px;paint-order:stroke;' +
      'letter-spacing:1.5px}',
      // inset() REFUSES negative values — an invalid `to` drops the whole
      // keyframe, leaves the text clipped at 100%, and the scrawl never
      // appears at all. (It did. The DOM had three of them and the screen
      // had none.) The svg carries its own padding instead.
      '@keyframes ycpg-write{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0)}}',
      // …on the SVG, not on its wrapper. The wrapper is shrink-to-fit and the
      // svg's own centring margins are NEGATIVE, so the wrapper's box comes
      // out about half the width of the drawing — and a clip-path on the
      // wrapper therefore cuts the first half of every word clean off. (It
      // did. Three words, all missing their beginnings.) The svg's box is the
      // drawing, so the clip belongs there.
      '.yc-obj-graffiti svg{animation:ycpg-write .9s steps(16,end) both}',
      /* …and rubbed out when you press it */
      '@keyframes ycpg-rub{0%{opacity:1;filter:blur(0)}' +
      '35%{opacity:.7;filter:blur(1px) saturate(.4)}' +
      '100%{opacity:0;filter:blur(5px) saturate(0)}}',
      '.yc-obj-wipe{animation:ycpg-rub .42s ease-out forwards}'
    ]
  });
})();
