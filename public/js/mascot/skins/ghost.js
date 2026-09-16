/* public/js/mascot/skins/ghost.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, GHOST FORM — the noclip one
 *
 * The skin the drift/blink pair was built for: it lifts off ledges and
 * wanders with gravity switched off, and now and then it fades out entirely
 * and turns up somewhere else — occasionally right beside the cursor, which
 * is the better joke. Everything physical it still does, it does dreamily:
 * GRAVITY is tuned down to a fifth, so a released or startled ghost sinks
 * like a feather onto whatever is below and lands on the ordinary landing
 * path, no new machinery.
 *
 * Pickable year-round and seasonal never: the ruling was no Halloween window
 * — a ghost is a form, not a holiday.
 *
 * The sheet reads in both themes the way the fur and the brass do: literal
 * near-whites with a grey outline, lifted by the engine's dark-mode filter.
 * The fade on blink lives HERE (a transition on .g-all), because the engine
 * only owns when the sprite is elsewhere — never what leaving looks like.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'ghost',
    name: 'Ghost',
    blurb: 'Ignores gravity, respects the modals.',

    // A tallish sheet; the hem is the foot line. No ascent in `can`, so
    // FLY_HEAD is the sprite's own height per the contract's convention —
    // a ghost with a balloon would be gilding the afterlife.
    geom: { W: 28, H: 30, FLY_HEAD: 30 },

    tune: {
      GRAVITY: 300,          // a fifth of a cat's — it sinks, it does not fall
      TERMINAL: 130,
      WALK: 30,              // a glide, not a stroll
      CHASE: 80,
      DRIFT_CHANCE: 0.45     // what makes the noclip pair actually happen
    },

    // Core, chase, and the noclip pair. No climbing or hanging — walls are
    // other people's problems — and no hop: why jump when you can simply
    // decline to land?
    can: ['walk', 'idle', 'chase', 'fall', 'land', 'drag', 'leave', 'drift', 'blink'],

    acts: [
      ['bob', 28], ['peer', 22], ['boo', 16], ['fade', 16]
    ],

    // When it notices you, it peers.
    lookAct: 'peer',

    lines: [
      'I have no body of evidence.',
      'Boo. Allegedly.',
      'Present, though hard to serve.',
      'Objection: hearsay. I hear everything.',
      'The chain of custody passed right through me.',
      'I haunt on retainer.',
      'Notarized? I can barely be witnessed.',
      'Discovery: I was here the whole time.',
      'My alibi is excellent. I was everywhere.',
      'Cold spot? That is my office.',
      'I do my best work after hours. All of them.',
      'Unfinished business is my whole practice.',
      'I passed through the firewall. It tickled.',
      'Deposition noted. I will float it.',
      'Adjourned. Through the wall.'
    ],

    words: { idle: 'settle', chase: 'chase me', drift: 'float about', blink: 'vanish', peer: 'peer about' },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 28×30, side-ish view facing right, hem on the bottom edge. One sheet,
    // two arms, two eyes, a mouth for booing. Neutral pose is the hover-stand,
    // which is the portrait.
    svg:
      '<svg class="g-svg" viewBox="0 0 28 30" width="28" height="30" aria-hidden="true" focusable="false">' +
      '<g class="g-all">' +
      '<g class="g-body">' +
      // the sheet: dome down to a four-point hem
      '<path d="M3 29.2 V13 Q3 3 14 3 Q25 3 25 13 V29.2 L21.4 25.9 L17.7 29.2 L14 25.9 L10.3 29.2 L6.6 25.9 Z"' +
      ' fill="#ECEFF4" stroke="#A8B0BA" stroke-width=".8" stroke-linejoin="round"/>' +
      // a fold of shadow along the trailing side, so the sheet has a front
      '<path d="M6.2 12.5 Q6 6.5 11 4.6" fill="none" stroke="#D2D8E0" stroke-width="1.1" stroke-linecap="round"/>' +
      '<path d="M5.4 16 v9" stroke="#D2D8E0" stroke-width="1" stroke-linecap="round"/>' +
      '</g>' +
      // arms: little sheet nubs, posable
      '<path class="g-armL" d="M3.4 15.5 q-3.1 1 -2.6 3.9" fill="none" stroke="#A8B0BA" stroke-width="1.6" stroke-linecap="round"/>' +
      '<path class="g-armR" d="M24.6 15.5 q3.1 1 2.6 3.9" fill="none" stroke="#A8B0BA" stroke-width="1.6" stroke-linecap="round"/>' +
      // the face, set toward the leading edge
      '<g class="g-eyes">' +
      '<ellipse cx="15.2" cy="11.6" rx="1.5" ry="2.2" fill="#2A2118"/>' +
      '<ellipse cx="20.6" cy="11.6" rx="1.5" ry="2.2" fill="#2A2118"/>' +
      '</g>' +
      '<ellipse class="g-mouth" cx="18" cy="16.6" rx="1.2" ry="1.6" fill="#2A2118"/>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // Everything eases — nothing about a ghost is stepped. The blink fade is
    // the opacity transition on .g-all: the engine flips the state, this is
    // what the flip looks like, in both directions.
    css: [
      '.g-all{transform-origin:14px 30px;transition:transform .2s ease-out,opacity .22s ease}',
      '.g-armL{transform-origin:3.4px 15.5px}.g-armR{transform-origin:24.6px 15.5px}',
      '.g-armL,.g-armR,.g-mouth,.g-eyes{transition:transform .2s ease-out}',
      '.g-mouth{transform-box:fill-box;transform-origin:50% 50%}',

      /* the ambient hover — a pet that floats must never hold perfectly still */
      '@keyframes ycg-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.6px)}}',
      '@keyframes ycg-blinkEyes{0%,94%,100%{transform:scaleY(1)}96%,98%{transform:scaleY(.1)}}',
      '.g-eyes{transform-box:fill-box;transform-origin:50% 50%;animation:ycg-blinkEyes 5.1s infinite}',
      '[data-state="idle"] .g-all{animation:ycg-bob 2.6s ease-in-out infinite}',

      /* gliding: the bob quickens and the sheet leans into it */
      '[data-state="walk"] .g-all{animation:ycg-bob 1.4s ease-in-out infinite}',
      '[data-state="walk"] .g-armL,[data-state="walk"] .g-armR{transform:rotate(8deg)}',
      '[data-state="chase"] .g-all{animation:ycg-bob .7s ease-in-out infinite}',
      '[data-state="chase"] .g-mouth{transform:scale(1.7)}',      /* boo in progress */
      '[data-state="chase"] .g-armL{transform:rotate(38deg)}',
      '[data-state="chase"] .g-armR{transform:rotate(-30deg)}',

      /* sinking (a ghost does not fall): hem trails, arms up */
      '[data-state="fall"] .g-armL{transform:rotate(46deg)}',
      '[data-state="fall"] .g-armR{transform:rotate(-46deg)}',
      '[data-state="fall"] .g-all{transform:scaleY(1.05)}',

      /* the landing — barely a settle */
      '@keyframes ycg-land{0%{transform:scaleY(.9) scaleX(1.05)}100%{transform:none}}',
      '[data-state="land"] .g-all{animation:ycg-land .22s ease-out}',

      /* carried: stretched from the scruff it does not have */
      '[data-state="drag"] .g-all{transform:scaleY(1.12) scaleX(.94)}',
      '[data-state="drag"] .g-armL{transform:rotate(55deg)}',
      '[data-state="drag"] .g-armR{transform:rotate(-55deg)}',

      /* drifting: the deep slow bob plus a sway — the engine drives the path,
         this is just the body language on top of it */
      '@keyframes ycg-drift{0%,100%{transform:rotate(-3deg) translateY(0)}50%{transform:rotate(3deg) translateY(-2px)}}',
      '[data-state="drift"] .g-all{animation:ycg-drift 2.8s ease-in-out infinite}',

      /* blinking: the fade itself. The transition on .g-all carries it out
         AND back in when the engine reappears in drift. */
      '[data-state="blink"] .g-all{opacity:0}',

      /* idle repertoire */
      '[data-act="bob"] .g-all{animation-duration:1.6s}',
      '@keyframes ycg-peer{0%,20%{transform:translateX(0)}35%,50%{transform:translateX(-1.8px)}65%,80%{transform:translateX(1.6px)}100%{transform:translateX(0)}}',
      '[data-act="peer"] .g-eyes{animation:ycg-peer 3.2s ease-in-out infinite,ycg-blinkEyes 5.1s infinite}',
      '[data-act="boo"] .g-all{transform:scaleX(1.12) scaleY(.96)}',
      '[data-act="boo"] .g-mouth{transform:scale(2.1)}',
      '[data-act="boo"] .g-armL{transform:rotate(52deg)}',
      '[data-act="boo"] .g-armR{transform:rotate(-44deg)}',
      '@keyframes ycg-fade{0%,100%{opacity:1}50%{opacity:.42}}',
      '[data-act="fade"] .g-all{animation:ycg-fade 2.4s ease-in-out infinite}'
    ]
  });
})();
