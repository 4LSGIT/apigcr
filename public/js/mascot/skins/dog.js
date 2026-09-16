/* public/js/mascot/skins/dog.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, DOG FORM — the one that is pleased to see you
 *
 * Mark II. The first one read as a wolverine: a lumpy barrel with a boxy head
 * stuck on the end and four sticks under it. The fixes are all silhouette —
 * a deep chest and a tucked waist instead of one even sausage, a proper long
 * MUZZLE (the single most dog-shaped thing there is), a big floppy ear with a
 * fold in it, legs with actual elbows and hocks, and a tail that sweeps up in
 * a curve rather than standing up like an aerial.
 *
 * What makes it a form rather than a recolour is where its errand ENDS. The
 * goose's heist is: go somewhere, take a thing, carry it to MY corner. The dog
 * runs the identical machinery with one field changed — `to: 'cursor'` — and
 * it becomes the opposite gesture: go and get the ball, bring it to YOU. That
 * leg re-aims every frame, so moving the mouse moves the destination and it
 * changes course mid-trot.
 *
 * AND YOU CAN THROW IT. Press the ball and drag: it arcs, bounces off the
 * floor, rolls to a stop, and the dog chases it the whole way — the out leg
 * re-aims at the ball's live position, so it runs after a moving ball rather
 * than to where it used to be. Let go without dragging and it lobs. Then it
 * brings it back, sets it at your pointer, and waits for you to do it again.
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
    blurb: 'Throw the ball — press it and drag. It will bring it back to you.',

    geom: { W: 42, H: 30, FLY_HEAD: 30 },

    roam: true,
    upright: true,

    tune: {
      WALK: 105,             // a trot with business in mind
      GRAVITY: 520,
      HEIST_CHANCE: 0.6      // it would like to do this all day
    },

    can: ['walk', 'idle', 'fall', 'land', 'drag', 'leave'],

    // The kit: a ball, and the stick it will accept as a substitute.
    heist: {
      to: 'cursor',
      props: [
        // a tennis ball
        '<svg width="16" height="16" viewBox="0 0 16 16">' +
        '<circle cx="8" cy="8" r="7.2" fill="#D8E84A" stroke="#93A12B" stroke-width=".8"/>' +
        '<path d="M1.6 4.6 Q8 8 1.6 11.4 M14.4 4.6 Q8 8 14.4 11.4" fill="none" stroke="#F6FAD9" stroke-width="1.1"/>' +
        '</svg>',
        // a stick
        '<svg width="22" height="12" viewBox="0 0 22 12"><g transform="rotate(-12 11 6)">' +
        '<path d="M2.4 6.6 L19 5" stroke="#9A7346" stroke-width="2.8" stroke-linecap="round"/>' +
        '<path d="M6.6 6.2 L4.4 3.2 M13.6 5.4 L15.8 8.4" stroke="#8A6539" stroke-width="1.6" stroke-linecap="round"/>' +
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
    // 42×30, side profile facing +x, feet on the bottom edge.
    //
    // The shape, in order of how much it matters: the MUZZLE (long, low, with
    // a dark nose past the jaw — no other animal reads this way), the deep
    // chest running back to a tucked waist, the floppy folded EAR, hocks and
    // elbows so the legs bend the right ways, and a tail that curves up and
    // over. Far legs are drawn first and darker, so the body sits between the
    // two pairs and the thing has depth.
    svg:
      '<svg class="d-svg" viewBox="0 0 42 30" width="42" height="30" aria-hidden="true" focusable="false">' +
      '<g class="d-all">' +

      // ── far pair, behind the body ─────────────────────────────────────────
      '<g class="d-legBR">' +
      '<path d="M13.4 18.6 C12.2 21 12.6 23.4 11.8 26.4" fill="none" stroke="#A06F33" stroke-width="2.8" stroke-linecap="round"/>' +
      '<path d="M10.2 27.4 L14 27.4" stroke="#8E5F2A" stroke-width="2.4" stroke-linecap="round"/>' +
      '</g>' +
      '<g class="d-legFR">' +
      '<path d="M29.4 18.4 C29.8 21 29.4 23.6 29.8 26.4" fill="none" stroke="#A06F33" stroke-width="2.8" stroke-linecap="round"/>' +
      '<path d="M28.2 27.4 L32 27.4" stroke="#8E5F2A" stroke-width="2.4" stroke-linecap="round"/>' +
      '</g>' +

      // ── THE TAIL, sweeping up and over ────────────────────────────────────
      '<g class="d-tail">' +
      '<path d="M8.6 14 C5 12.6 2.8 9.4 3.4 5.8 C3.8 3.6 5.4 2.4 7 2.8" fill="none"' +
      ' stroke="#C98D46" stroke-width="3.2" stroke-linecap="round"/>' +
      '<path d="M6.6 3.4 C5.6 2.6 5.8 1.6 6.8 1.2" fill="none" stroke="#E7B876" stroke-width="2.6" stroke-linecap="round"/>' +
      '</g>' +

      // ── the body: deep chest forward, waist tucked aft ────────────────────
      '<path class="d-body" d="M9.4 13.2 C8.6 17.2 10.4 19.8 14.4 20.4' +
      ' C18.6 21 24 21 28.2 20.2 C31.8 19.5 33.6 17.2 33.4 13.6' +
      ' C33.2 10.2 31 8.6 27.4 8.8 L14.6 9.4 C11.2 9.6 9.8 10.8 9.4 13.2 Z"' +
      ' fill="#D19A52" stroke="#87591F" stroke-width=".8" stroke-linejoin="round"/>' +
      // the paler underside, which is what makes the chest read as a chest
      '<path class="d-belly" d="M12.6 19.4 C17 21.2 24 21.2 29 19.6 C27.4 20.9 14.8 21 12.6 19.4 Z" fill="#EFD3A6"/>' +

      // ── near pair, over the body ──────────────────────────────────────────
      '<g class="d-legBL">' +
      '<path d="M15.6 19.4 C14.2 22 14.8 24.2 14 27" fill="none" stroke="#D8A45E" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M12.2 28.2 L16.4 28.2" stroke="#B07A38" stroke-width="2.6" stroke-linecap="round"/>' +
      '</g>' +
      '<g class="d-legFL">' +
      '<path d="M27.2 19.4 C27.8 22 27.2 24.4 27.8 27" fill="none" stroke="#D8A45E" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M26 28.2 L30.2 28.2" stroke="#B07A38" stroke-width="2.6" stroke-linecap="round"/>' +
      '</g>' +

      // ── THE HEAD, hinged at the neck ──────────────────────────────────────
      '<g class="d-head">' +
      // skull
      '<path d="M30.4 12.6 C30 9 32.2 6.4 35.2 6.2 C38.4 6 40.4 8 40.4 11' +
      ' C40.4 13.4 39.4 15 37.2 15.4 L32.6 15.8 C31.2 15.9 30.5 14.6 30.4 12.6 Z"' +
      ' fill="#D19A52" stroke="#87591F" stroke-width=".8" stroke-linejoin="round"/>' +
      // THE MUZZLE — long, low, past the jaw. The most dog-shaped thing here.
      '<path class="d-muzzle" d="M36.2 12.8 L41.6 12.4 C42 14.6 41 16.3 38.8 16.5' +
      ' L36.4 16.6 C35.4 16.6 35 15.8 35.1 14.6 Z"' +
      ' fill="#EFD3A6" stroke="#87591F" stroke-width=".65" stroke-linejoin="round"/>' +
      '<ellipse cx="41.2" cy="12.9" rx="1.35" ry="1.05" fill="#2E241A"/>' +
      '<path class="d-mouth" d="M36.6 15.6 q1.8 .9 3.4 -.3" fill="none" stroke="#A9743A" stroke-width=".55" stroke-linecap="round"/>' +
      // the eye, set where a dog’s is — above and behind the muzzle line
      '<circle class="d-eye" cx="35.6" cy="10.4" r="1.25" fill="#2E241A"/>' +
      '<circle cx="36.05" cy="9.95" r=".4" fill="#FFFFFF"/>' +
      '<path class="d-brow" d="M34.2 8.4 q1.5 -.8 2.8 -.1" fill="none" stroke="#B9813F" stroke-width=".75" stroke-linecap="round"/>' +
      // THE EAR — big, floppy, folded, hung off the back of the skull
      '<g class="d-ear">' +
      '<path d="M32.4 7.6 C30.2 6.6 28.4 8.2 28.2 11.2 C28 14.4 29.4 16.6 31.4 16.8' +
      ' C33 16.9 33.6 15 33.4 12.4 C33.3 10 33.4 8.1 32.4 7.6 Z"' +
      ' fill="#A97236" stroke="#7A4E1C" stroke-width=".7" stroke-linejoin="round"/>' +
      '<path d="M30.4 9.6 C29.6 11.2 29.8 13.6 30.8 15.2" fill="none" stroke="#8A5F28" stroke-width=".6" opacity=".7"/>' +
      '</g>' +
      '</g>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // Two things carry this form: the four-beat TROT (diagonal pairs, which is
    // what stops it reading as a pantomime horse) and the TAIL, which is on in
    // every single state because that is the joke.
    css: [
      '.d-all{transform-origin:21px 30px;transition:transform .18s ease}',
      '.d-tail{transform-origin:8.6px 14px}',
      '.d-head{transform-origin:31px 13px;transition:transform .22s ease}',
      '.d-ear{transform-origin:32.4px 7.6px}',
      '.d-body{transform-box:fill-box;transform-origin:50% 70%}',
      '.d-legBR{transform-origin:13.4px 18.6px}.d-legFR{transform-origin:29.4px 18.4px}',
      '.d-legBL{transform-origin:15.6px 19.4px}.d-legFL{transform-origin:27.2px 19.4px}',
      '.d-legBR,.d-legFR,.d-legBL,.d-legFL{transition:transform .12s ease}',

      /* the tail. always. */
      '@keyframes ycd-wag{0%,100%{transform:rotate(-15deg)}50%{transform:rotate(19deg)}}',
      '.d-tail{animation:ycd-wag .5s ease-in-out infinite}',
      /* and the ear answers every movement a beat late */
      '@keyframes ycd-ear{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(9deg)}}',

      /* THE TROT: diagonal pairs, so back-left swings with front-right */
      '@keyframes ycd-gaitA{0%,100%{transform:rotate(-22deg)}50%{transform:rotate(22deg)}}',
      '@keyframes ycd-gaitB{0%,100%{transform:rotate(22deg)}50%{transform:rotate(-22deg)}}',
      '@keyframes ycd-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.5px)}}',
      '[data-state="walk"] .d-legBR,[data-state="walk"] .d-legFL{animation:ycd-gaitA .24s ease-in-out infinite}',
      '[data-state="walk"] .d-legBL,[data-state="walk"] .d-legFR{animation:ycd-gaitB .24s ease-in-out infinite}',
      '[data-state="walk"] .d-all{animation:ycd-bounce .24s ease-in-out infinite}',
      '[data-state="walk"] .d-tail{animation:ycd-wag .24s ease-in-out infinite}',
      '[data-state="walk"] .d-ear{animation:ycd-ear .24s ease-in-out infinite .06s}',

      /* carrying: head up, prize forward, tail beside itself */
      '[data-carry="1"] .d-head{transform:rotate(-10deg) translateY(-1px)}',
      '[data-carry="1"] .d-tail{animation:ycd-wag .15s ease-in-out infinite}',

      /* idle: it is waiting for you to do something */
      '@keyframes ycd-breathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.03)}}',
      '[data-state="idle"] .d-body{animation:ycd-breathe 2.2s ease-in-out infinite}',

      /* thrown: legs out, ears up, entirely unbothered */
      '[data-state="fall"] .d-legBR,[data-state="fall"] .d-legBL{transform:rotate(-36deg)}',
      '[data-state="fall"] .d-legFR,[data-state="fall"] .d-legFL{transform:rotate(36deg)}',
      '[data-state="fall"] .d-head{transform:rotate(-15deg)}',
      '[data-state="fall"] .d-ear{transform:rotate(-26deg)}',
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
      '@keyframes ycd-wiggle{0%,100%{transform:rotate(-1.8deg)}50%{transform:rotate(1.8deg)}}',
      '[data-act="wag"] .d-tail{animation:ycd-wag .12s ease-in-out infinite}',
      '[data-act="wag"] .d-all{animation:ycd-wiggle .24s ease-in-out infinite}',
      '[data-act="wag"] .d-ear{animation:ycd-ear .24s ease-in-out infinite}',
      /* sit — hindquarters down, front legs straight, chest proud */
      '[data-act="sit"] .d-legBR,[data-act="sit"] .d-legBL{transform:rotate(-46deg) translateY(2px)}',
      '[data-act="sit"] .d-all{transform:translateY(2px) rotate(-4deg)}',
      '[data-act="sit"] .d-head{transform:rotate(-7deg)}',
      /* sniff — nose to the floor, tail high, small busy sweeps */
      '@keyframes ycd-snuffle{0%,100%{transform:rotate(27deg) translate(-1px,3px)}50%{transform:rotate(31deg) translate(1px,3.8px)}}',
      '[data-act="sniff"] .d-head{animation:ycd-snuffle .32s ease-in-out infinite}',
      '[data-act="sniff"] .d-tail{transform:rotate(-28deg)}',
      /* shake — the full-body shake, head leading, ear flying */
      '@keyframes ycd-shakeBody{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}',
      '@keyframes ycd-shakeHead{0%,100%{transform:rotate(-12deg)}50%{transform:rotate(12deg)}}',
      '@keyframes ycd-shakeEar{0%,100%{transform:rotate(-24deg)}50%{transform:rotate(24deg)}}',
      '[data-act="shake"] .d-all{animation:ycd-shakeBody .1s linear infinite}',
      '[data-act="shake"] .d-head{animation:ycd-shakeHead .08s linear infinite}',
      '[data-act="shake"] .d-ear{animation:ycd-shakeEar .08s linear infinite}',

      /* the ball, once it is put down for you */
      '.yc-obj-loot{margin-left:-8px;margin-top:-8px}',
      /* …and while it is in the air, where the engine is driving it */
      '.yc-obj-thrown{filter:drop-shadow(0 2px 3px rgba(0,0,0,.28))}'
    ]
  });
})();
