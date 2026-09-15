/* public/js/mascot/skins/casey95.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY-95, THE ROBOT YISRACAT
 *
 * A Win95-era robot cat — button-grey plates with a white bevel and a grey
 * shadow, rivets, a visor with an LED that sweeps, a spring-cable tail, piston
 * legs, and a JETPACK where the balloon goes. It began life as a full fork of
 * mascot.js (84KB of copy for a skin's worth of change); this file is what was
 * actually different, and the fork is gone.
 *
 * The one lesson that fork taught, now a contract rule: the ascent states are
 * the ENGINE's `inflate` → `float` → `pop`, whatever the art paints over them —
 * here a turbine spooling, a burn, and a flame-out. The fork renamed them
 * ignite/boost/cutout in code, and that rename was the entire reason it had to
 * copy the engine. The `words` table below is where a robot gets to call the
 * trick a jetpack; the state names it styles are the engine's.
 *
 * THE WIN95 BEVEL is the whole look and it is why there is not a gradient in
 * here: every plate is a flat face, a white line along its top, a grey line
 * along its bottom, and a near-black outline. Four greys and one LED:
 *   #C6CAD0 face · #F4F7FA highlight · #8B929B shade · #5A616B dark
 *   #2F343B outline · #4FE3C1 LED · #FF6B4A warning · #FFC94A/#FF7A32 flame
 * Those fills stay literal for the reason Casey's do: this is ARTWORK, not
 * chrome. A steel robot has to read as a steel robot in both themes, and there
 * is no token for "robot" — dark mode lifts the sprite a little harder than the
 * engine default, in the override at the top of the css. The two pieces that
 * ARE app UI — the speech bubble and the standby dots — take app tokens.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'casey95',
    name: 'Casey-95',
    blurb: 'A Win95 robot cat. The same moves in button-grey plate — and a jetpack.',

    // Same 36×28 box and the same pivots as Casey (hips at y 18.5, neck at
    // 25,12, tail root at 6,15), so every pose the physics asks for still means
    // what it meant there. FLY_HEAD is just the sprite's own height: the
    // exhaust points DOWN, so nothing about this rig sticks up over the robot
    // but its own ears — which is why the strip under the header is an ordinary
    // target for it rather than a special case.
    geom: { W: 36, H: 28, FLY_HEAD: 30 },

    // A jetpack is not a balloon: more thrust, a faster ceiling, less sway, a
    // shorter spool and a longer flame-out. Everything else keeps the engine
    // defaults — a robot ambles at the same speed as a cat; what makes it read
    // as a machine is the STEPPED easing in the css, not the px/s.
    tune: {
      FLY_MAX_SECS: 9,       // longest a burn may last, at FLY_MAX_VY
      FLY_LIFT: 260,         // px/s² of thrust, so it takes up the slack quickly
      FLY_MAX_VY: 120,       // px/s ceiling on the rise. A jetpack, not a missile.
      FLY_SWAY: 6,           // px of drift about the launch column — a wobbly vector
      INFLATE_MS: 0.8,       // wind-up: the turbine spooling and the flame catching
      POP_MS: 0.3            // the flame-out and the smoke, before it starts falling
    },

    // Idle repertoire: look → scan, groom → oil, scratch → glitch, and standby
    // where the cat sleeps — sided like sleep is, so the charging bolt is never
    // mirrored, and long the same way.
    acts: [
      ['sit', 26], ['scan', 20], ['oil', 16],
      ['standby', 14, { face: 1, dur: [4, 9], cmdDur: [6, 12] }],
      ['stretch', 12], ['glitch', 12]
    ],

    lines: [
      'MEOW.EXE has performed an illegal operation.',
      'Purr driver not found. Retrying.',
      'Nap cycle initiated. Do not power off.',
      'I have indexed this ledge. It is mine.',
      'Objection, in 640K of memory.',
      'Defragmenting. Do not pet.',
      'Warning: low tuna. Insert disk 2.',
      'I read the contract. Checksum: fine.',
      'Motion to sleep. Compiling.',
      'A general protection fault, but a cosy one.',
      'Boot complete. Where is the sun?',
      'Discovery: one loose screw. Mine now.',
      'Retainer: one battery. Daily.',
      'I am not stuck. This is a feature.',
      'Adjourned. Entering sleep.'
    ],

    words: { idle: 'settle', fly: 'jetpack', chase: 'chase me', scan: 'scan about', oil: 'oil up' },

    // When it notices you it scans — its name for what the cat calls a look.
    lookAct: 'scan',

    // ── The sprite ─────────────────────────────────────────────────────────────
    // Side view, facing right, feet on the bottom edge. Parts are grouped so the
    // CSS below can pose them per state; the neutral pose is standing, which is
    // also the picker portrait.
    svg:
      '<svg class="r-svg" viewBox="0 0 36 28" width="36" height="28" aria-hidden="true" focusable="false">' +
      '<g class="r-all">' +
      // TAIL — a segmented cable with a plug on the end, dashed rather than drawn
      // segment by segment: eight little rects would cost eight nodes and read the
      // same at 36px wide.
      '<g class="r-tail">' +
      '<path d="M6 15 C1 15.5 -0.5 9 2.5 5.5" fill="none" stroke="#8B929B" stroke-width="2.9"' +
      ' stroke-linecap="round" stroke-dasharray="2.4 .85"/>' +
      '<circle cx="2.5" cy="5.2" r="1.8" fill="#C6CAD0" stroke="#2F343B" stroke-width=".6"/>' +
      '<circle class="r-tailled" cx="2.5" cy="5.2" r=".65" fill="#4FE3C1"/>' +
      '</g>' +
      // THE JETPACK. Drawn ABOVE and BELOW the viewBox, which works because the svg
      // is overflow:visible. Hidden by default and shown by three state selectors
      // only — see the note on .r-jet in the CSS, that is load-bearing.
      '<g class="r-jet">' +
      '<g class="r-smoke">' +
      '<circle cx="2.2" cy="26.2" r="2.1" fill="#9AA1AA"/>' +
      '<circle cx="4.7" cy="29" r="1.5" fill="#B4BAC2"/>' +
      '<circle cx="-.1" cy="29.9" r="1.8" fill="#A6ADB6"/>' +
      '</g>' +
      '<g class="r-flame">' +
      '<path d="M2.2 34 q-3 -4.6 -3 -7.4 q0 -3.4 3 -3.9 q3 .5 3 3.9 q0 2.8 -3 7.4 Z" fill="#FF7A32"/>' +
      '<path d="M2.2 30.6 q-1.5 -2.4 -1.5 -3.9 q0 -1.8 1.5 -2.1 q1.5 .3 1.5 2.1 q0 1.5 -1.5 3.9 Z" fill="#FFC94A"/>' +
      '</g>' +
      '<path d="M-.4 20.4 h5.2 l-.9 3.6 h-3.4 Z" fill="#5A616B"/>' +        /* nozzle */
      '<rect x="-.9" y="8.2" width="6.6" height="12.3" rx="2.5" fill="#AEB5BE" stroke="#2F343B" stroke-width=".7"/>' +
      '<rect x="-1.3" y="7.2" width="7.4" height="2.5" rx="1.2" fill="#5A616B" stroke="#2F343B" stroke-width=".6"/>' +
      '<rect x="0" y="9.6" width="1.3" height="9.2" rx=".65" fill="#F4F7FA" opacity=".75"/>' +
      '<path d="M-.7 12.6 h5.2 M-.7 16.4 h5.2" stroke="#7C838C" stroke-width=".8"/>' +
      '<path d="M6.6 11.3 V21.7" stroke="#7C838C" stroke-width="1.5"/>' +   /* the strap */
      '<g class="r-spark">' +
      '<path d="M-1.4 22.2 l-1.7 1.3 M5.8 22.2 l1.7 1.3 M2.2 25.4 v2.1" fill="none"' +
      ' stroke="#FFC94A" stroke-width="1.1" stroke-linecap="round"/>' +
      '</g></g>' +
      // LEGS — piston housing, shaft, magnetic foot pad. The far pair is a shade
      // darker, which is all the depth a 36px sprite can carry.
      '<g class="r-leg r-bl">' +
      '<rect x="8" y="17.5" width="3.4" height="5.4" rx=".7" fill="#8B929B" stroke="#2F343B" stroke-width=".5"/>' +
      '<rect x="9" y="22" width="1.4" height="3.6" fill="#4E555E"/>' +
      '<rect x="7.5" y="25.2" width="4.4" height="2.8" rx=".8" fill="#8B929B" stroke="#2F343B" stroke-width=".5"/>' +
      '</g>' +
      '<g class="r-leg r-fl">' +
      '<rect x="19" y="17.5" width="3.4" height="5.4" rx=".7" fill="#8B929B" stroke="#2F343B" stroke-width=".5"/>' +
      '<rect x="20" y="22" width="1.4" height="3.6" fill="#4E555E"/>' +
      '<rect x="18.5" y="25.2" width="4.4" height="2.8" rx=".8" fill="#8B929B" stroke="#2F343B" stroke-width=".5"/>' +
      '</g>' +
      // CHASSIS — one plate, bevelled top and bottom, a vent stack at the rump and
      // an instrument panel at the shoulder.
      '<rect class="r-body" x="5" y="11" width="23" height="11" rx="2.4" fill="#C6CAD0" stroke="#2F343B" stroke-width=".7"/>' +
      '<path d="M6.6 12.1 H26.4" stroke="#F4F7FA" stroke-width="1.1" stroke-linecap="round"/>' +
      '<path d="M6.6 20.9 H26.4" stroke="#8B929B" stroke-width="1.1" stroke-linecap="round"/>' +
      '<path class="r-vent" d="M8.6 13.7 v5.1 M10.8 13.7 v5.1 M13 13.7 v5.1"' +
      ' stroke="#8B929B" stroke-width="1.2" stroke-linecap="round"/>' +
      '<circle cx="16.2" cy="12.6" r=".55" fill="#8B929B"/>' +
      '<circle cx="16.2" cy="20.4" r=".55" fill="#8B929B"/>' +
      '<rect x="17.8" y="13.4" width="8.2" height="5.6" rx="1" fill="#2B3038" stroke="#2F343B" stroke-width=".5"/>' +
      '<circle class="r-led" cx="19.8" cy="16.2" r="1" fill="#4FE3C1"/>' +
      '<path d="M22.2 14.8 h2.6 M22.2 16.4 h2.6 M22.2 18 h2.6" stroke="#5A616B" stroke-width=".7"/>' +
      '<g class="r-leg r-br">' +
      '<rect x="11.6" y="17.5" width="3.4" height="5.4" rx=".7" fill="#C6CAD0" stroke="#2F343B" stroke-width=".5"/>' +
      '<rect x="12.6" y="22" width="1.4" height="3.6" fill="#5A616B"/>' +
      '<rect x="11.1" y="25.2" width="4.4" height="2.8" rx=".8" fill="#C6CAD0" stroke="#2F343B" stroke-width=".5"/>' +
      '</g>' +
      '<g class="r-leg r-fr">' +
      '<rect x="22.6" y="17.5" width="3.4" height="5.4" rx=".7" fill="#C6CAD0" stroke="#2F343B" stroke-width=".5"/>' +
      '<rect x="23.6" y="22" width="1.4" height="3.6" fill="#5A616B"/>' +
      '<rect x="22.1" y="25.2" width="4.4" height="2.8" rx=".8" fill="#C6CAD0" stroke="#2F343B" stroke-width=".5"/>' +
      '</g>' +
      // HEAD — a boxed CRT with an antenna, ears pressed out of sheet metal, and a
      // visor whose LED tracks left and right instead of blinking.
      '<g class="r-head">' +
      '<rect x="22.4" y="9.6" width="3.6" height="4.6" fill="#8B929B"/>' +
      '<path d="M24.4 5.6 L25.6 1.2 L28.6 4.6 Z" fill="#8B929B" stroke="#2F343B" stroke-width=".6" stroke-linejoin="round"/>' +
      '<path d="M31.2 4.2 L33.8 1.1 L34.6 5.6 Z" fill="#C6CAD0" stroke="#2F343B" stroke-width=".6" stroke-linejoin="round"/>' +
      '<g class="r-ant">' +
      '<path d="M30 4.8 L31.2 1" stroke="#5A616B" stroke-width=".9" stroke-linecap="round"/>' +
      '<circle class="r-antball" cx="31.3" cy=".8" r="1.15" fill="#FF6B4A"/>' +
      '</g>' +
      '<rect x="23.8" y="4.4" width="11.4" height="11.2" rx="2.2" fill="#C6CAD0" stroke="#2F343B" stroke-width=".7"/>' +
      '<path d="M25 5.6 H34" stroke="#F4F7FA" stroke-width="1.1" stroke-linecap="round"/>' +
      '<path d="M25 14.4 H34" stroke="#8B929B" stroke-width="1" stroke-linecap="round"/>' +
      '<rect x="26" y="7.4" width="8.6" height="3.8" rx="1.9" fill="#23272E"/>' +
      '<rect class="r-eye" x="30.4" y="8.3" width="2.8" height="2" rx="1" fill="#4FE3C1"/>' +
      '<rect class="r-lid" x="26" y="7.4" width="8.6" height="3.8" rx="1.9" fill="#3A4048"/>' +
      '<rect x="30.9" y="12.2" width="3.7" height="2.4" rx=".8" fill="#8B929B"/>' +
      '<path d="M31.6 12.8 v1.2 M32.7 12.8 v1.2 M33.8 12.8 v1.2" stroke="#2F343B" stroke-width=".45"/>' +
      '<path d="M34.9 12.5 h1.6 M34.9 14.1 h1.4" stroke="#5A616B" stroke-width=".55" stroke-linecap="round"/>' +
      '</g>' +
      // The sonar arcs, shown only while it is scanning. Outside .r-head on purpose:
      // they are what it is looking AT, so they hold still while the head sweeps.
      '<g class="r-ping">' +
      '<path d="M36.8 8.2 q2 2.6 0 5.2 M38.6 6.6 q3 4.2 0 8.4" fill="none"' +
      ' stroke="#4FE3C1" stroke-width="1.1" stroke-linecap="round"/>' +
      '</g>' +
      '</g>' +
      // STANDBY — a charging bolt and two status dots, where the cat has its z's.
      '<g class="r-zzz">' +
      '<path class="r-bolt" d="M32.6 -3.4 L30.2 1.2 H31.9 L31.1 4.6 L33.9 -.2 H32.1 Z"' +
      ' fill="#FFC94A" stroke="#2F343B" stroke-width=".4" stroke-linejoin="round"/>' +
      '<circle class="r-d1" cx="35.2" cy="-1.2" r=".9"/>' +
      '<circle class="r-d2" cx="36.6" cy="-4.6" r=".9"/>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // The theme note in one line: Casey eases its poses, and this skin STEPS
    // them. Every transition and most of the animations here run on steps(), so
    // limbs snap between positions the way a servo does instead of arriving
    // softly. It is the single cheapest thing that makes the same skeleton read
    // as a machine, and it is why the timings below are mostly Casey's numbers.
    css: function (CFG) {
      return [
        // Two overrides of the engine base, allowed because skin css lands
        // after it: the bubble squares off (4px, not 13 — what it is quoting is
        // a system dialog), and dark mode lifts the steel a little harder.
        '.yc-say{border-radius:4px}',
        'html[data-theme="dark"] .yc-cat{filter:drop-shadow(0 1px 2px rgba(0,0,0,.55)) brightness(1.12)}',

        /* pivots: Casey's exactly — legs from the hip, head from the neck, tail
           from the rump — plus the two this skin adds, both at the nozzle mouth */
        '.r-bl{transform-origin:9.7px 18.5px}.r-br{transform-origin:13.3px 18.5px}',
        '.r-fl{transform-origin:20.7px 18.5px}.r-fr{transform-origin:24.3px 18.5px}',
        '.r-head{transform-origin:25px 12px}.r-tail{transform-origin:6px 15px}',
        '.r-all{transform-origin:18px 28px}',
        '.r-flame,.r-spark{transform-origin:2.2px 23.6px}.r-smoke{transform-origin:2.2px 26px}',
        '.r-leg,.r-head,.r-tail,.r-all{transition:transform .12s steps(2,end)}',

        /* the walk is two frames on purpose — the stutter is what makes it 1995 */
        '@keyframes ycr-legA{0%,49%{transform:rotate(16deg)}50%,100%{transform:rotate(-16deg)}}',
        '@keyframes ycr-legB{0%,49%{transform:rotate(-16deg)}50%,100%{transform:rotate(16deg)}}',
        '@keyframes ycr-bob{0%,49%{transform:translateY(0)}50%,100%{transform:translateY(-1px)}}',
        /* the tail is a cable on a servo: sweep, hold, sweep back */
        '@keyframes ycr-tail{0%,38%{transform:rotate(-9deg)}50%,88%{transform:rotate(11deg)}100%{transform:rotate(-9deg)}}',
        /* the visor LED tracks instead of blinking, in visible steps, and the whole
           eye drops out for a frame now and then — that is the CRT, not a blink */
        '@keyframes ycr-track{0%,100%{transform:translateX(-2.1px)}50%{transform:translateX(1.9px)}}',
        '@keyframes ycr-flick{0%,96.4%,100%{opacity:1}96.8%,98.4%{opacity:.12}}',
        '@keyframes ycr-blip{0%,58%{opacity:1}59%,100%{opacity:.16}}',
        '.r-eye{animation:ycr-track 3.6s steps(7,end) infinite,ycr-flick 5.3s infinite}',
        '.r-antball{animation:ycr-blip 1.6s steps(1,end) infinite}',
        '.r-led{animation:ycr-blip 2.3s steps(1,end) infinite}',
        '.r-tailled{animation:ycr-blip 3.1s steps(1,end) infinite}',
        '.r-lid{opacity:0}',
        '.r-ping{opacity:0}',

        /* walk / chase / climb / hang share a gait, at different tempos */
        '[data-state="walk"] .r-fr,[data-state="walk"] .r-bl,',
        '[data-state="chase"] .r-fr,[data-state="chase"] .r-bl,',
        '[data-state="climb"] .r-fr,[data-state="climb"] .r-bl,',
        '[data-state="hang"] .r-fr,[data-state="hang"] .r-bl{animation:ycr-legA .26s infinite}',
        '[data-state="walk"] .r-fl,[data-state="walk"] .r-br,',
        '[data-state="chase"] .r-fl,[data-state="chase"] .r-br,',
        '[data-state="climb"] .r-fl,[data-state="climb"] .r-br,',
        '[data-state="hang"] .r-fl,[data-state="hang"] .r-br{animation:ycr-legB .26s infinite}',
        '[data-state="walk"] .r-all,[data-state="chase"] .r-all{animation:ycr-bob .26s infinite}',
        '[data-state="chase"] .r-fr,[data-state="chase"] .r-bl,',
        '[data-state="chase"] .r-fl,[data-state="chase"] .r-br{animation-duration:.17s}',
        '[data-state="climb"] .r-fr,[data-state="climb"] .r-bl,',
        '[data-state="climb"] .r-fl,[data-state="climb"] .r-br{animation-duration:.34s}',
        '[data-state="hang"] .r-fr,[data-state="hang"] .r-bl,',
        '[data-state="hang"] .r-fl,[data-state="hang"] .r-br{animation-duration:.42s}',
        '[data-state="walk"] .r-tail,[data-state="idle"] .r-tail{animation:ycr-tail 1.15s steps(4,end) infinite}',
        '[data-state="chase"] .r-tail{animation:ycr-tail .5s steps(4,end) infinite}',
        /* the magnets are working, so the status lights are */
        '[data-state="climb"] .r-antball,[data-state="hang"] .r-antball{animation-duration:.5s}',

        /* airborne: legs splay, the cable streams, the visor goes to warning */
        '[data-state="fall"] .r-fl,[data-state="fall"] .r-fr{transform:rotate(-34deg)}',
        '[data-state="fall"] .r-bl,[data-state="fall"] .r-br{transform:rotate(30deg)}',
        '[data-state="fall"] .r-tail{transform:rotate(-32deg)}',
        '[data-state="fall"] .r-head{transform:rotate(-8deg)}',
        '[data-state="fall"] .r-eye{fill:#FF6B4A;animation:ycr-blip .18s steps(1,end) infinite}',

        /* dropping to a lower perch: the servos gather, then the tuck */
        '[data-state="crouch"] .r-all{transform:translateY(3px) scaleY(.80) scaleX(1.09)}',
        '[data-state="crouch"] .r-head{transform:rotate(7deg)}',      /* eyeing the landing */
        '[data-state="crouch"] .r-tail{transform:rotate(-20deg)}',
        '[data-state="hop"] .r-fl,[data-state="hop"] .r-fr{transform:rotate(-26deg)}',
        '[data-state="hop"] .r-bl,[data-state="hop"] .r-br{transform:rotate(22deg)}',
        '[data-state="hop"] .r-tail{transform:rotate(-30deg)}',
        '[data-state="hop"] .r-head{transform:rotate(6deg)}',
        '[data-state="hop"] .r-all{transform:scaleY(1.06) scaleX(.95)}',

        /* ── the jetpack — the engine's inflate/float/pop, painted as a burn ────
           Shown ONLY by these three state selectors, and hidden by default. That
           is load-bearing, not tidiness, and it is inherited straight from the
           balloon: it means toLeave(), a drag, the ground going away mid-spool
           and every other way out of a burn all put the pack away for free,
           without a single one of them having to know it exists. */
        '.r-jet{opacity:0}',
        '[data-state="inflate"] .r-jet,[data-state="float"] .r-jet,[data-state="pop"] .r-jet{opacity:1}',
        '.r-flame,.r-spark,.r-smoke{opacity:0}',
        /* the spool-up catches, drops, and catches properly — a cold start, not a
           fade-in. Stepped, because a flame that eases on reads as a dimmer. */
        '@keyframes ycr-spool{0%{opacity:0;transform:scaleY(.05) scaleX(.5)}',
        '30%{opacity:1;transform:scaleY(.34) scaleX(.8)}55%{transform:scaleY(.16) scaleX(.7)}',
        '78%{transform:scaleY(.62) scaleX(.96)}100%{opacity:1;transform:none}}',
        '@keyframes ycr-burn{0%{transform:scaleY(.86) scaleX(1.06)}50%{transform:scaleY(1.14) scaleX(.94)}100%{transform:scaleY(.86) scaleX(1.06)}}',
        '@keyframes ycr-die{0%{opacity:1;transform:none}55%{opacity:.7;transform:scaleY(.32) scaleX(1.25)}100%{opacity:0;transform:scaleY(0)}}',
        '@keyframes ycr-sparks{0%{opacity:0}18%,55%{opacity:1}100%{opacity:0;transform:scale(1.5)}}',
        '@keyframes ycr-puff{0%{opacity:.85;transform:none}100%{opacity:0;transform:translateY(-8px) scale(1.7)}}',
        '@keyframes ycr-shudder{0%,100%{transform:translateX(-.4px)}50%{transform:translateX(.4px)}}',
        /* the hover pivots about the NOZZLE, not the feet: the thing holding it up
           is down there, so a wobble in the thrust swings the head furthest. */
        '@keyframes ycr-hover{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}',
        '[data-state="inflate"] .r-flame{opacity:1;animation:ycr-spool ' + CFG.INFLATE_MS + 's steps(9,end) both}',
        '[data-state="inflate"] .r-spark{animation:ycr-sparks ' + CFG.INFLATE_MS + 's steps(6,end) both}',
        '[data-state="inflate"] .r-all{transform:translateY(2px) scaleY(.94) scaleX(1.05)}',
        '[data-state="inflate"] .r-head{transform:rotate(8deg)}',      /* braced for it */
        '[data-state="inflate"] .r-tail{transform:rotate(-24deg)}',
        '[data-state="float"] .r-flame{opacity:1;animation:ycr-burn .11s steps(2,end) infinite}',
        '[data-state="float"] .r-jet{animation:ycr-shudder .07s steps(2,end) infinite}',
        '[data-state="float"] .r-all{transform-origin:2.2px 23.6px;animation:ycr-hover 1.8s ease-in-out infinite}',
        /* NOT a dangle on all four: four legs swinging in antiphase is a gait, and
           a flying robot that appears to be walking is the whole illusion gone.
           The front pair holds the splay the fall pose uses — which already reads
           as airborne — and only the back pair swings. */
        '[data-state="float"] .r-fl,[data-state="float"] .r-fr{transform:rotate(-16deg)}',
        '[data-state="float"] .r-bl,[data-state="float"] .r-br{animation:ycr-dangle 1.7s ease-in-out infinite}',
        '[data-state="float"] .r-br{animation-delay:.85s}',
        '[data-state="float"] .r-tail{transform:rotate(20deg)}',
        '[data-state="float"] .r-head{transform:rotate(-8deg)}',
        '[data-state="pop"] .r-flame{opacity:1;animation:ycr-die ' + CFG.POP_MS + 's ease-out forwards}',
        '[data-state="pop"] .r-smoke{opacity:1;animation:ycr-puff ' + (CFG.POP_MS * 2.2).toFixed(2) + 's ease-out forwards}',
        '[data-state="pop"] .r-head{transform:rotate(-15deg)}',    /* flamed out */
        '[data-state="pop"] .r-eye{fill:#FF6B4A}',
        '[data-state="pop"] .r-fl,[data-state="pop"] .r-fr{transform:rotate(-38deg)}',
        '[data-state="pop"] .r-bl,[data-state="pop"] .r-br{transform:rotate(34deg)}',
        '[data-state="pop"] .r-all{transform:scaleY(.94) scaleX(1.07)}',

        /* the landing clank */
        '@keyframes ycr-land{0%{transform:scaleY(.68) scaleX(1.18)}55%{transform:scaleY(1.06) scaleX(.96)}100%{transform:none}}',
        '[data-state="land"] .r-all{animation:ycr-land .22s steps(4,end)}',

        /* held up by the scruff of its chassis */
        '@keyframes ycr-dangle{0%{transform:rotate(-14deg)}50%{transform:rotate(14deg)}100%{transform:rotate(-14deg)}}',
        '[data-state="drag"] .r-leg{animation:ycr-dangle .32s steps(2,end) infinite}',
        '[data-state="drag"] .r-br,[data-state="drag"] .r-fr{animation-delay:.16s}',
        '[data-state="drag"] .r-tail{transform:rotate(-24deg)}',
        '[data-state="drag"] .r-eye{fill:#FF6B4A;animation:ycr-blip .22s steps(1,end) infinite}',

        /* idle repertoire */
        '[data-act="sit"] .r-all{transform:translateY(2px)}',
        '[data-act="sit"] .r-bl,[data-act="sit"] .r-br{transform:rotate(62deg)}',
        '@keyframes ycr-look{0%,20%{transform:rotate(0)}35%,50%{transform:rotate(-15deg)}65%,80%{transform:rotate(13deg)}100%{transform:rotate(0)}}',
        '@keyframes ycr-ping{0%{opacity:0;transform:translateX(-2px)}30%{opacity:.95}100%{opacity:0;transform:translateX(2.5px)}}',
        '[data-act="scan"] .r-head{animation:ycr-look 3.4s steps(9,end) infinite}',
        '[data-act="scan"] .r-ping{animation:ycr-ping 1.6s ease-out infinite}',
        /* oil: the head goes down to the shoulder joint and a foreleg works at it —
           the same two-part gesture the cat grooms with, on a can of oil */
        '@keyframes ycr-oilH{0%,100%{transform:rotate(0)}40%,70%{transform:rotate(25deg) translateY(1px)}}',
        '@keyframes ycr-oilP{0%,100%{transform:rotate(0)}40%{transform:rotate(-62deg)}55%{transform:rotate(-48deg)}70%{transform:rotate(-62deg)}}',
        '[data-act="oil"] .r-head{animation:ycr-oilH 1.8s ease-in-out infinite}',
        '[data-act="oil"] .r-fr{animation:ycr-oilP 1.8s ease-in-out infinite}',
        '[data-act="oil"] .r-all{transform:translateY(2px)}',
        /* stretch: the pistons telescope out and back, in four visible stops */
        '@keyframes ycr-stretch{0%,100%{transform:none}45%{transform:scaleX(1.16) scaleY(.86) translateY(2px)}}',
        '[data-act="stretch"] .r-all{animation:ycr-stretch 2.2s steps(7,end) infinite}',
        '[data-act="stretch"] .r-tail{transform:rotate(-34deg)}',
        /* glitch — the cat scratches an ear here. This one disagrees with itself
           for a few seconds: the chassis jitters a pixel and the visor argues
           about what colour an alarm is. */
        '@keyframes ycr-glitch{0%{transform:translate(-.7px,0)}25%{transform:translate(.7px,-.5px)}',
        '50%{transform:translate(-.5px,.5px)}75%{transform:translate(.6px,.2px)}100%{transform:translate(-.7px,0)}}',
        '@keyframes ycr-err{0%,100%{fill:#FF6B4A}50%{fill:#4FE3C1}}',
        '[data-act="glitch"] .r-all{animation:ycr-glitch .09s steps(1,end) infinite}',
        '[data-act="glitch"] .r-eye{animation:ycr-err .16s steps(1,end) infinite}',
        '[data-act="glitch"] .r-head{transform:rotate(-6deg)}',

        /* standby — the visor shutters, everything folds, the charger comes on.
           It always faces right (acts opts), so the bolt is never mirrored. */
        '[data-act="standby"] .r-all{transform:translateY(4px) scaleY(.84) scaleX(1.05)}',
        '[data-act="standby"] .r-leg{transform:rotate(72deg)}',
        '[data-act="standby"] .r-lid{opacity:1}',
        '[data-act="standby"] .r-eye{opacity:0;animation:none}',
        '[data-act="standby"] .r-antball{animation-duration:2.6s}',
        '[data-act="standby"] .r-tail{transform:rotate(24deg)}',
        '.r-zzz{opacity:0}',
        // The dots are muted text over the page, so they take the app token,
        // exactly as the cat's z's do. The bolt does not: it is a light on the
        // robot.
        '.r-zzz circle{fill:var(--text-muted);transform-box:fill-box;transform-origin:50% 50%}',
        '@keyframes ycr-z{0%{opacity:0;transform:translate(0,0) scale(.7)}25%{opacity:.9}100%{opacity:0;transform:translate(4px,-9px) scale(1.1)}}',
        '@keyframes ycr-charge{0%,100%{opacity:.22}50%{opacity:1}}',
        '[data-act="standby"] .r-zzz{opacity:1}',
        '[data-act="standby"] .r-bolt{animation:ycr-charge 1.9s steps(3,end) infinite}',
        '[data-act="standby"] .r-d1{animation:ycr-z 2.6s ease-out infinite}',
        '[data-act="standby"] .r-d2{animation:ycr-z 2.6s ease-out infinite 1.3s}'
      ];
    }
  });
})();
