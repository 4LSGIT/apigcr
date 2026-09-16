/* public/js/mascot/skins/bat.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, BAT FORM — the one that never gives up
 *
 * Every chaser before this one loses interest: the cat's chase is a ledge-bound
 * sprint with a timer, the roomba's a doomed shuffle. The bat is the answer to
 * "make one that really chases the cursor the entire time": PURSUE is
 * full-screen homing flight that only ends by catching, and the catch is the
 * joke — the bat treats the caught cursor as a BRANCH, swings underneath it,
 * and hangs there upside down (PERCH), perfectly content, until the branch
 * inexplicably flies off again. Then it simply resumes. It is not angry. It is
 * a bat, and that was a branch.
 *
 * On the ground it is, correctly, terrible: a folded shuffle on wing-wrists at
 * WALK 16. Its real travel is drift — fluttering wander — and drift's roost
 * run, the climb to the top of the window to hang from the "rafters" (the
 * engine's drift/hang machinery; no climbing involved, bats don't).
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'bat',
    name: 'Bat',
    blurb: 'A bat. Hunts your cursor across the whole screen, catches it, and hangs from it like a branch.',

    // Wide for the wingspan, short in the body. No ascent set in `can`, so
    // FLY_HEAD is the sprite's own height per the contract's convention.
    geom: { W: 30, H: 16, FLY_HEAD: 16 },

    tune: {
      WALK: 16,              // bats are famously bad at floors
      HANGSPEED: 10,         // the upside-down ceiling shuffle
      GRAVITY: 340,          // a flutter-down, not a plummet
      TERMINAL: 150,
      DRIFT_CHANCE: 0.45,    // its real element is the air…
      PURSUE_CHANCE: 0.5     // …and its real hobby is your cursor
    },

    // Walks (badly), flutters, roosts, hunts. Never climbs — the roost run
    // and the ceiling are drift's business — and never phases like the ghost.
    can: ['walk', 'idle', 'fall', 'land', 'drag', 'leave',
      'hang', 'drift', 'pursue', 'perch'],

    acts: [
      ['fold', 26], ['peek', 24], ['flap', 20], ['chitter', 18]
    ],

    // When it notices you, one eye appears over the wing.
    lookAct: 'peek',

    lines: [
      'I only work nights. Bill accordingly.',
      'Hanging by a precedent.',
      'My chambers are upside down.',
      'Echolocation finds every asset. Every one.',
      'Blind as a bat? I read the fine print.',
      'Your cursor has been served.',
      'I attach to moving assets.',
      'Everything looks better inverted. Ask any balance sheet.',
      'The gavel comes down. I stay up.',
      'Nocturnal filing beats the queue.',
      'I see best in dark dockets.',
      'I hang, therefore I am.',
      'The belfry is my corner office.',
      'That branch keeps leaving. Branches do not do that.',
      'Court adjourned till dusk.'
    ],

    words: {
      idle: 'settle', drift: 'flutter about', pursue: 'hunt my cursor',
      hang: 'roost', fold: 'wrap up', peek: 'peek out',
      flap: 'stretch wings', chitter: 'chitter'
    },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 30×16, feet on the bottom edge, eyes forward (+x) so the engine's facing
    // flip reads. The wings are separate groups hinged at the shoulders: flight
    // is the two of them beating, the ground shuffle is the two of them used as
    // crutches, and every roosting pose is the two of them wrapped shut. The
    // echolocation arcs (.b-ping) ship hidden; only `chitter` shows them.
    svg:
      '<svg class="b-svg" viewBox="0 0 30 16" width="30" height="16" aria-hidden="true" focusable="false">' +
      '<g class="b-all">' +
      // left wing: shoulder at (12.5,7), two membrane scallops on the trailing edge
      '<g class="b-wingL">' +
      '<path d="M12.5 7 L2 3.4 L1 8.4 Q3.8 7.2 5.6 9.4 Q8.2 7.6 9.6 10.4 Q11 8.6 12.5 9.6 Z"' +
      ' fill="#4A4458" stroke="#2C2836" stroke-width=".6" stroke-linejoin="round"/>' +
      '<path d="M12.5 7 L5.6 9.4 M12.5 7 L1 8.4" fill="none" stroke="#2C2836" stroke-width=".45" opacity=".6"/>' +
      '</g>' +
      // right wing, mirrored: shoulder at (17.5,7)
      '<g class="b-wingR">' +
      '<path d="M17.5 7 L28 3.4 L29 8.4 Q26.2 7.2 24.4 9.4 Q21.8 7.6 20.4 10.4 Q19 8.6 17.5 9.6 Z"' +
      ' fill="#4A4458" stroke="#2C2836" stroke-width=".6" stroke-linejoin="round"/>' +
      '<path d="M17.5 7 L24.4 9.4 M17.5 7 L29 8.4" fill="none" stroke="#2C2836" stroke-width=".45" opacity=".6"/>' +
      '</g>' +
      '<g class="b-body">' +
      // ears first, so the head overlaps their roots
      '<path d="M12 4.2 L11.4 .6 L14 2.6 Z" fill="#4A4458" stroke="#2C2836" stroke-width=".5" stroke-linejoin="round"/>' +
      '<path d="M18 4.2 L18.6 .6 L16 2.6 Z" fill="#4A4458" stroke="#2C2836" stroke-width=".5" stroke-linejoin="round"/>' +
      '<path d="M12.2 3.4 L11.9 1.8 L13.2 2.8 Z" fill="#B98FA5"/>' +
      '<path d="M17.8 3.4 L18.1 1.8 L16.8 2.8 Z" fill="#B98FA5"/>' +
      // the torso: fuzzy pear, lighter muzzle patch
      '<ellipse cx="15" cy="8.6" rx="4.6" ry="5.4" fill="#5A5370" stroke="#2C2836" stroke-width=".6"/>' +
      '<ellipse cx="15.6" cy="10.6" rx="2.7" ry="2.6" fill="#8B8299" opacity=".55"/>' +
      // eyes forward: amber, pupils leading
      '<circle class="b-eye" cx="14.6" cy="6.6" r="1" fill="#FFB84D"/>' +
      '<circle class="b-eye" cx="17.2" cy="6.6" r="1" fill="#FFB84D"/>' +
      '<circle cx="14.9" cy="6.6" r=".45" fill="#1C1922"/>' +
      '<circle cx="17.5" cy="6.6" r=".45" fill="#1C1922"/>' +
      // the nose-leaf and two proud little fangs
      '<path d="M15.9 7.9 l.6 .8 l-1.2 0 Z" fill="#B98FA5"/>' +
      '<path class="b-mouth" d="M15 9.8 q.9 .5 1.8 0" fill="none" stroke="#2C2836" stroke-width=".5" stroke-linecap="round"/>' +
      '<path d="M15.2 9.9 l.25 .8 l.3 -.75 M16.5 9.9 l.25 .8 l.3 -.75" fill="none" stroke="#F4F7FA" stroke-width=".45" stroke-linecap="round"/>' +
      // feet: two hooks on the baseline — the grip, whichever way is up
      '<path d="M13.4 13.6 l-.3 1.9 q-.6 .5 -1.1 .1 M16.6 13.6 l.3 1.9 q.6 .5 1.1 .1"' +
      ' fill="none" stroke="#2C2836" stroke-width=".7" stroke-linecap="round"/>' +
      '</g>' +
      // echolocation, for the chitter act only
      '<g class="b-ping">' +
      '<path d="M20.5 8.6 q1.4 1.2 0 2.4 M22.3 7.9 q2.2 1.9 0 3.8" fill="none" stroke="#8B8299" stroke-width=".6" stroke-linecap="round"/>' +
      '</g>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // Two vocabularies: the WING BEAT (flight — drift, pursue, falling panic)
    // and the WRAP (everything roosted — hang, perch, fold, peek). The engine
    // already turns the whole element for the ceiling (rot=180); PERCH is the
    // one pose the skin inverts itself, because there the anchor is a caught
    // cursor, not a surface.
    css: [
      '.b-all{transform-origin:15px 8px;transition:transform .22s ease}',
      '.b-wingL{transform-origin:12.5px 7px}.b-wingR{transform-origin:17.5px 7px}',
      '.b-wingL,.b-wingR{transition:transform .18s ease}',
      '.b-body{transform-origin:15px 9px;transition:transform .18s ease}',
      '.b-ping{opacity:0}',

      /* the wing beat, at three tempos */
      '@keyframes ycb-beatL{0%,100%{transform:rotate(-26deg)}50%{transform:rotate(14deg)}}',
      '@keyframes ycb-beatR{0%,100%{transform:rotate(26deg)}50%{transform:rotate(-14deg)}}',
      '@keyframes ycb-bob{0%,100%{transform:translateY(.6px)}50%{transform:translateY(-.6px)}}',
      '[data-state="drift"] .b-wingL{animation:ycb-beatL .34s ease-in-out infinite}',
      '[data-state="drift"] .b-wingR{animation:ycb-beatR .34s ease-in-out infinite}',
      '[data-state="drift"] .b-body{animation:ycb-bob .34s ease-in-out infinite}',
      /* the hunt: same beat, urgent */
      '[data-state="pursue"] .b-wingL{animation:ycb-beatL .16s linear infinite}',
      '[data-state="pursue"] .b-wingR{animation:ycb-beatR .16s linear infinite}',
      '[data-state="pursue"] .b-body{animation:ycb-bob .16s linear infinite}',
      /* falling: all flap, no lift — commitment without results */
      '[data-state="fall"] .b-wingL{animation:ycb-beatL .12s linear infinite}',
      '[data-state="fall"] .b-wingR{animation:ycb-beatR .12s linear infinite}',

      /* the ground shuffle: wings as crutches, body lurching between them */
      '@keyframes ycb-crutchL{0%,100%{transform:rotate(-8deg) scaleX(.55)}50%{transform:rotate(6deg) scaleX(.55)}}',
      '@keyframes ycb-crutchR{0%,100%{transform:rotate(8deg) scaleX(.55)}50%{transform:rotate(-6deg) scaleX(.55)}}',
      '@keyframes ycb-lurch{0%,100%{transform:rotate(-3deg) translateY(.3px)}50%{transform:rotate(3deg) translateY(-.3px)}}',
      '[data-state="walk"] .b-wingL{animation:ycb-crutchL .5s ease-in-out infinite}',
      '[data-state="walk"] .b-wingR{animation:ycb-crutchR .5s ease-in-out infinite}',
      '[data-state="walk"] .b-body{animation:ycb-lurch .5s ease-in-out infinite}',

      /* roosting on the ceiling: the engine has flipped the element; the skin
         wraps the wings and shivers now and then like a settling umbrella */
      '@keyframes ycb-shiver{0%,88%,100%{transform:rotate(0)}92%{transform:rotate(2.5deg)}96%{transform:rotate(-2.5deg)}}',
      '[data-state="hang"] .b-wingL{transform:rotate(-30deg) scaleX(.42)}',
      '[data-state="hang"] .b-wingR{transform:rotate(30deg) scaleX(.42)}',
      '[data-state="hang"] .b-all{animation:ycb-shiver 5s ease-in-out infinite}',

      /* PERCH — the caught cursor is a branch and this is the only correct
         use of a branch: the skin inverts itself (rot stays 0; the anchor is
         the cursor, feet up), wraps, and radiates satisfaction. The delayed
         sway lets the .22s transition swing the flip in first. */
      '@keyframes ycb-settle{0%,100%{transform:rotate(179deg)}50%{transform:rotate(181deg)}}',
      '[data-state="perch"] .b-all{transform:rotate(180deg);animation:ycb-settle 3.4s ease-in-out .3s infinite}',
      '[data-state="perch"] .b-wingL{transform:rotate(-32deg) scaleX(.4)}',
      '[data-state="perch"] .b-wingR{transform:rotate(32deg) scaleX(.4)}',

      /* idle: wings half-shut, catching its breath */
      '[data-state="idle"] .b-wingL{transform:rotate(-16deg) scaleX(.7)}',
      '[data-state="idle"] .b-wingR{transform:rotate(16deg) scaleX(.7)}',
      '[data-state="idle"] .b-body{animation:ycb-bob 2.2s ease-in-out infinite}',

      /* carried: hangs from the grip, wings adroop, slow indignant half-flaps */
      '@keyframes ycb-droopL{0%,100%{transform:rotate(-38deg) scaleX(.8)}50%{transform:rotate(-26deg) scaleX(.85)}}',
      '@keyframes ycb-droopR{0%,100%{transform:rotate(38deg) scaleX(.8)}50%{transform:rotate(26deg) scaleX(.85)}}',
      '[data-state="drag"] .b-wingL{animation:ycb-droopL 1.1s ease-in-out infinite}',
      '[data-state="drag"] .b-wingR{animation:ycb-droopR 1.1s ease-in-out infinite}',

      /* the landing: a squash on the wrists */
      '@keyframes ycb-land{0%{transform:scaleY(.78) scaleX(1.12)}60%{transform:scaleY(1.06) scaleX(.96)}100%{transform:none}}',
      '[data-state="land"] .b-all{animation:ycb-land .22s ease-out}',

      /* idle repertoire */
      /* fold — the full wrap, head tucked: a small dark parcel */
      '[data-act="fold"] .b-wingL{transform:rotate(-34deg) scaleX(.38)}',
      '[data-act="fold"] .b-wingR{transform:rotate(34deg) scaleX(.38)}',
      '[data-act="fold"] .b-body{transform:translateY(.8px) scale(.96)}',
      /* peek — the wrap, minus one wing's worth of secrecy */
      '@keyframes ycb-peek{0%,25%,100%{transform:rotate(-34deg) scaleX(.38)}45%,80%{transform:rotate(-10deg) scaleX(.75)}}',
      '[data-act="peek"] .b-wingL{animation:ycb-peek 2.8s ease-in-out infinite}',
      '[data-act="peek"] .b-wingR{transform:rotate(34deg) scaleX(.38)}',
      /* flap — the big luxurious stretch, both wings to full reach */
      '@keyframes ycb-stretchL{0%,100%{transform:rotate(-16deg) scaleX(.7)}45%{transform:rotate(4deg) scaleX(1.06)}}',
      '@keyframes ycb-stretchR{0%,100%{transform:rotate(16deg) scaleX(.7)}45%{transform:rotate(-4deg) scaleX(1.06)}}',
      '[data-act="flap"] .b-wingL{animation:ycb-stretchL 1.6s ease-in-out infinite}',
      '[data-act="flap"] .b-wingR{animation:ycb-stretchR 1.6s ease-in-out infinite}',
      /* chitter — head bobs, mouth works, the pings go out */
      '@keyframes ycb-chit{0%,100%{transform:translateY(0)}50%{transform:translateY(-.5px)}}',
      '@keyframes ycb-ping{0%,20%{opacity:0}45%{opacity:.9}100%{opacity:0}}',
      '[data-act="chitter"] .b-body{animation:ycb-chit .22s ease-in-out infinite}',
      '[data-act="chitter"] .b-ping{animation:ycb-ping .9s ease-out infinite}'
    ]
  });
})();
