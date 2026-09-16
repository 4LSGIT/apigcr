/* public/js/mascot/skins/dog.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, DOG FORM — the one that is pleased to see you
 *
 * The plan always wanted a dog for the contrast — "same locomotion, opposite
 * personality" — but a dog that only trots about would be a recolour. What
 * makes this one a form is where its errand ENDS.
 *
 * The goose's heist is: go somewhere, take a thing, carry it to MY corner.
 * The dog runs the identical machinery with one field changed — `to: 'cursor'`
 * — and it becomes the opposite gesture: go and get the ball, and bring it to
 * YOU. The delivery leg re-aims every frame, so moving the mouse moves the
 * destination and it changes course mid-trot; it sets the ball down at your
 * pointer, looks up, and waits. Move away and it fetches the very same ball
 * again rather than producing a new one, which is why the floor never fills
 * up with tennis balls.
 *
 * It takes nothing off your page. Fetching is not stealing, and the engine
 * enforces that distinction rather than trusting this file.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'dog',
    name: 'Dog',
    blurb: 'Brings you the ball. Move the mouse and it brings it there instead.',

    geom: { W: 38, H: 28, FLY_HEAD: 28 },

    roam: true,
    upright: true,

    tune: {
      WALK: 95,              // a trot with business in mind
      GRAVITY: 520,
      HEIST_CHANCE: 0.6      // it would like to do this all day
    },

    can: ['walk', 'idle', 'fall', 'land', 'drag', 'leave'],

    // The kit: a ball, and the stick it will accept as a substitute.
    heist: {
      to: 'cursor',
      props: [
        // a tennis ball
        '<svg width="14" height="14" viewBox="0 0 14 14">' +
        '<circle cx="7" cy="7" r="6.4" fill="#D8E84A" stroke="#9AA82E" stroke-width=".7"/>' +
        '<path d="M1.4 4.2 Q7 7 1.4 9.8 M12.6 4.2 Q7 7 12.6 9.8" fill="none" stroke="#F4F9D8" stroke-width=".9"/>' +
        '</svg>',
        // a stick
        '<svg width="20" height="10" viewBox="0 0 20 10"><g transform="rotate(-12 10 5)">' +
        '<path d="M2 5.6 L17.5 4.2" stroke="#9A7346" stroke-width="2.4" stroke-linecap="round"/>' +
        '<path d="M6 5.2 L4 2.6 M12.5 4.6 L14.5 7.2" stroke="#8A6539" stroke-width="1.4" stroke-linecap="round"/>' +
        '</g></svg>'
      ]
    },

    acts: [
      ['wag', 30], ['sit', 24], ['sniff', 22], ['shake', 16]
    ],

    // When it notices you. Of course it is the tail.
    lookAct: 'wag',

    lines: [
      'I found it. I found it again.',
      'Throw it. I will wait. I will not wait long.',
      'Retainer? I retained the ball.',
      'Good case. Good case!',
      'I brought you a thing. It is the same thing.',
      'Discovery! I discovered it under the desk.',
      'Motion to play. Motion granted.',
      'I do not read the file. I carry the file.',
      'Every deadline met. At speed.',
      'Chain of custody: my mouth, then yours.',
      'I am billable and I am good.',
      'Somebody said walk. Somebody said it.',
      'The stick is also acceptable.',
      'Objection withdrawn, I saw a squirrel.',
      'Adjourned! Adjourned? Adjourned!'
    ],

    words: {
      idle: 'settle', steal: 'fetch the ball',
      wag: 'wag', sit: 'sit', sniff: 'sniff about', shake: 'shake out'
    },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 38×28, side profile facing +x, feet on the bottom edge. Legs are two
    // pairs on their own hinges so the trot can be a real four-beat gait; the
    // tail is the loudest thing about it and gets its own group everywhere.
    svg:
      '<svg class="d-svg" viewBox="0 0 38 28" width="38" height="28" aria-hidden="true" focusable="false">' +
      '<g class="d-all">' +
      // back legs (drawn under the body)
      '<g class="d-legBR">' +
      '<path d="M10 17.5 L8.6 25.5" stroke="#B9813F" stroke-width="2.6" stroke-linecap="round" fill="none"/>' +
      '<path d="M7 26.6 L10.8 26.6" stroke="#A06F33" stroke-width="2.2" stroke-linecap="round"/>' +
      '</g>' +
      '<g class="d-legFR">' +
      '<path d="M26 17.5 L27.4 25.5" stroke="#B9813F" stroke-width="2.6" stroke-linecap="round" fill="none"/>' +
      '<path d="M25.6 26.6 L29.4 26.6" stroke="#A06F33" stroke-width="2.2" stroke-linecap="round"/>' +
      '</g>' +
      // THE TAIL, hinged at the rump
      '<g class="d-tail">' +
      '<path d="M7.4 12.4 C3.6 10.6 2.2 7 3.4 4.2" fill="none" stroke="#C98D46" stroke-width="2.8" stroke-linecap="round"/>' +
      '<path d="M3.5 4.4 C2.6 3 2.8 1.8 3.6 1.2" fill="none" stroke="#E0A85E" stroke-width="2.2" stroke-linecap="round"/>' +
      '</g>' +
      // the body
      '<path class="d-body" d="M8.4 12.4 C8 17.6 11 19.6 16 19.6 L24 19.6 C28 19.6 30 17.4 29.6 13.6'
      + ' C29.2 10.4 26.6 9.4 23 9.6 L12.6 9.8 C9.8 9.9 8.6 10.6 8.4 12.4 Z"'
      + ' fill="#D19A52" stroke="#8A5F28" stroke-width=".7" stroke-linejoin="round"/>' +
      '<path class="d-belly" d="M12 18.6 q6 2 12 .2" fill="none" stroke="#EFD3A6" stroke-width="1.6" stroke-linecap="round"/>' +
      // front legs (over the body)
      '<g class="d-legBL">' +
      '<path d="M13.4 18 L12 25.8" stroke="#C98D46" stroke-width="2.6" stroke-linecap="round" fill="none"/>' +
      '<path d="M10.4 26.9 L14.2 26.9" stroke="#B07A38" stroke-width="2.2" stroke-linecap="round"/>' +
      '</g>' +
      '<g class="d-legFL">' +
      '<path d="M23.6 18 L25 25.8" stroke="#C98D46" stroke-width="2.6" stroke-linecap="round" fill="none"/>' +
      '<path d="M23.2 26.9 L27 26.9" stroke="#B07A38" stroke-width="2.2" stroke-linecap="round"/>' +
      '</g>' +
      // THE HEAD, hinged at the neck so it can dip to the ball and lift to you
      '<g class="d-head">' +
      '<path class="d-ear" d="M27.4 8 C25.6 5.6 26.4 3 28.6 2.6 C30.4 2.4 31 4.4 30.4 6.4 Z"'
      + ' fill="#A97236" stroke="#8A5F28" stroke-width=".6" stroke-linejoin="round"/>' +
      '<path d="M27 12.4 C26.6 8.4 29 6 32 6.2 C35 6.4 36.4 8.6 36.2 11.2 L36 13'
      + ' C35.8 14.6 34.4 15.4 32.4 15.4 L29.4 15.4 C27.8 15.4 27.1 14.2 27 12.4 Z"'
      + ' fill="#D19A52" stroke="#8A5F28" stroke-width=".7" stroke-linejoin="round"/>' +
      // the muzzle, the nose, the ever-present grin
      '<path d="M33.4 12.2 L37.4 12 C37.8 13.6 37 14.9 35.4 15 L33.6 15 Z"'
      + ' fill="#EFD3A6" stroke="#8A5F28" stroke-width=".55" stroke-linejoin="round"/>' +
      '<ellipse cx="37.1" cy="12.2" rx="1.1" ry=".85" fill="#2E241A"/>' +
      '<path class="d-mouth" d="M34 14.4 q1.4 .7 2.6 -.2" fill="none" stroke="#8A5F28" stroke-width=".5" stroke-linecap="round"/>' +
      '<circle class="d-eye" cx="32.6" cy="10.2" r="1.15" fill="#2E241A"/>' +
      '<circle cx="33" cy="9.8" r=".38" fill="#FFFFFF"/>' +
      '<path class="d-brow" d="M31.3 8.2 q1.3 -.7 2.5 -.1" fill="none" stroke="#A97236" stroke-width=".7" stroke-linecap="round"/>' +
      '</g>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // Two things carry this form: the four-beat TROT (diagonal pairs, which is
    // what stops it reading as a pantomime horse) and the TAIL, which is on in
    // every single state because that is the joke.
    css: [
      '.d-all{transform-origin:19px 28px;transition:transform .18s ease}',
      '.d-tail{transform-origin:7.4px 12.4px}',
      '.d-head{transform-origin:28px 13px;transition:transform .22s ease}',
      '.d-body{transform-box:fill-box;transform-origin:50% 60%}',
      '.d-legBR{transform-origin:10px 17.5px}.d-legFR{transform-origin:26px 17.5px}',
      '.d-legBL{transform-origin:13.4px 18px}.d-legFL{transform-origin:23.6px 18px}',
      '.d-legBR,.d-legFR,.d-legBL,.d-legFL{transition:transform .12s ease}',

      /* the tail. always. */
      '@keyframes ycd-wag{0%,100%{transform:rotate(-16deg)}50%{transform:rotate(20deg)}}',
      '.d-tail{animation:ycd-wag .5s ease-in-out infinite}',

      /* THE TROT: diagonal pairs, so back-left swings with front-right */
      '@keyframes ycd-gaitA{0%,100%{transform:rotate(-20deg)}50%{transform:rotate(20deg)}}',
      '@keyframes ycd-gaitB{0%,100%{transform:rotate(20deg)}50%{transform:rotate(-20deg)}}',
      '@keyframes ycd-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.3px)}}',
      '[data-state="walk"] .d-legBR,[data-state="walk"] .d-legFL{animation:ycd-gaitA .26s ease-in-out infinite}',
      '[data-state="walk"] .d-legBL,[data-state="walk"] .d-legFR{animation:ycd-gaitB .26s ease-in-out infinite}',
      '[data-state="walk"] .d-all{animation:ycd-bounce .26s ease-in-out infinite}',
      '[data-state="walk"] .d-tail{animation:ycd-wag .26s ease-in-out infinite}',

      /* carrying: head up, prize forward, tail beside itself */
      '[data-carry="1"] .d-head{transform:rotate(-9deg) translateY(-1px)}',
      '[data-carry="1"] .d-tail{animation:ycd-wag .16s ease-in-out infinite}',

      /* idle: the head tips. It is waiting for you to do something. */
      '@keyframes ycd-breathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.025)}}',
      '[data-state="idle"] .d-body{animation:ycd-breathe 2.2s ease-in-out infinite}',

      /* thrown: legs out, ears up, entirely unbothered */
      '[data-state="fall"] .d-legBR,[data-state="fall"] .d-legBL{transform:rotate(-34deg)}',
      '[data-state="fall"] .d-legFR,[data-state="fall"] .d-legFL{transform:rotate(34deg)}',
      '[data-state="fall"] .d-head{transform:rotate(-14deg)}',
      '[data-state="fall"] .d-tail{animation:ycd-wag .14s ease-in-out infinite}',

      '@keyframes ycd-land{0%{transform:scaleY(.78) scaleX(1.12)}60%{transform:scaleY(1.04) scaleX(.97)}100%{transform:none}}',
      '[data-state="land"] .d-all{animation:ycd-land .2s ease-out}',

      /* carried by you: perfectly happy about it */
      '@keyframes ycd-dangle{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(5deg)}}',
      '[data-state="drag"] .d-all{animation:ycd-dangle .7s ease-in-out infinite}',
      '[data-state="drag"] .d-legBR,[data-state="drag"] .d-legFL{animation:ycd-gaitA .3s ease-in-out infinite}',
      '[data-state="drag"] .d-legBL,[data-state="drag"] .d-legFR{animation:ycd-gaitB .3s ease-in-out infinite}',

      /* idle repertoire */
      /* wag — the whole back half joins in */
      '@keyframes ycd-wiggle{0%,100%{transform:rotate(-1.6deg)}50%{transform:rotate(1.6deg)}}',
      '[data-act="wag"] .d-tail{animation:ycd-wag .13s ease-in-out infinite}',
      '[data-act="wag"] .d-all{animation:ycd-wiggle .26s ease-in-out infinite}',
      /* sit — hindquarters down, front legs straight, chest proud */
      '[data-act="sit"] .d-legBR,[data-act="sit"] .d-legBL{transform:rotate(-44deg) translateY(2px)}',
      '[data-act="sit"] .d-all{transform:translateY(2px) rotate(-3deg)}',
      '[data-act="sit"] .d-head{transform:rotate(-6deg)}',
      /* sniff — nose to the floor, tail high, small busy sweeps */
      '@keyframes ycd-snuffle{0%,100%{transform:rotate(26deg) translate(-1px,3px)}50%{transform:rotate(30deg) translate(1px,3.6px)}}',
      '[data-act="sniff"] .d-head{animation:ycd-snuffle .34s ease-in-out infinite}',
      '[data-act="sniff"] .d-tail{transform:rotate(-26deg)}',
      /* shake — the full-body shake, head leading, ears flying */
      '@keyframes ycd-shakeBody{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}',
      '@keyframes ycd-shakeHead{0%,100%{transform:rotate(-11deg)}50%{transform:rotate(11deg)}}',
      '[data-act="shake"] .d-all{animation:ycd-shakeBody .1s linear infinite}',
      '[data-act="shake"] .d-head{animation:ycd-shakeHead .08s linear infinite}',

      /* the ball, once it is put down for you */
      '.yc-obj-loot{margin-left:-7px;margin-top:-7px}'
    ]
  });
})();
