/* public/js/mascot/skins/snail.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, SNAIL FORM — the one that signs its work
 *
 * The first skin with a TRAIL: everywhere it goes, it leaves a fading silvery
 * dab of slime, dropped by the engine's world-object layer — which exists so
 * that the risky decorations to come (a spider's webs) land on machinery this
 * harmless thing proved first. The engine keeps three promises about every
 * dropping: it can never take a click (pointer-events:none at the engine
 * level), there is a hard cap, and it fades and goes on a clock.
 *
 * Everything else is pace. WALK is a quarter of a cat's, the climb is slower
 * still, and yes, it chases the cursor — at 24 pixels a second, with total
 * conviction. It also climbs the walls and crosses the ceiling, because a
 * snail on the ceiling is the most snail a snail can be, and when it falls it
 * does the only correct thing: disappears into the shell until the landing.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'snail',
    name: 'Snail',
    blurb: 'A snail. Unhurried, and it signs its work.',

    // Low and small. No ascent in `can`, so FLY_HEAD is the sprite's own
    // height per the contract's convention.
    geom: { W: 26, H: 16, FLY_HEAD: 16 },

    tune: {
      WALK: 14,              // a quarter of a cat. This is the whole bit.
      CLIMB: 11,
      HANGSPEED: 8,
      CHASE: 24              // a doomed, determined pursuit
    },

    // Walks, climbs, hangs, chases — never jumps (obviously), never flies,
    // never phases through anything. A snail is COMMITTED to surfaces.
    can: ['walk', 'idle', 'chase', 'climb', 'hang', 'fall', 'land', 'drag', 'leave'],

    acts: [
      ['rest', 26], ['peer', 24], ['tuck', 18], ['stretch', 14]
    ],

    // When it notices you, the eye stalks do.
    lookAct: 'peer',

    lines: [
      'I billed travel time. All of it.',
      'Motion for extension. Of everything.',
      'I carry my office with me.',
      'Service of process: eventually.',
      'The trail is my signature block.',
      'Speedy trial? Objection.',
      'I read the whole file. It took a season.',
      'Rush job accepted. See you in spring.',
      'Every deadline is a suggestion of pace.',
      'I left a paper trail. It glistens.',
      'Slow is smooth. Smooth is billable.',
      'I am not late. The calendar is early.',
      'Continuance granted. By me. To me.',
      'The ceiling took a week. Worth it.',
      'Adjourned. Departure at dawn, arrival unknown.'
    ],

    words: { idle: 'settle', chase: 'chase me', peer: 'peer about', tuck: 'tuck in' },

    // The signature. Offset under the foot line by the css below; the engine
    // does the dropping, capping and fading.
    trail: {
      every: 10,
      life: 6,
      max: 40,
      svg: '<svg width="10" height="5" viewBox="0 0 10 5">' +
        '<ellipse cx="5" cy="2.5" rx="4.6" ry="1.8" fill="#BFD8E6" opacity=".45"/>' +
        '<ellipse cx="3.4" cy="2" rx="1.3" ry=".6" fill="#FFFFFF" opacity=".55"/>' +
        '</svg>'
    },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 26×16, side view, facing right, foot on the bottom edge. The body and
    // stalks tuck INTO the shell for falls and frights — the shell is drawn
    // last so they visibly retract behind it.
    svg:
      '<svg class="s-svg" viewBox="0 0 26 16" width="26" height="16" aria-hidden="true" focusable="false">' +
      '<g class="s-all">' +
      '<g class="s-body">' +
      // the foot: one long soft muscle, head rising at the front
      '<path d="M2.6 15.2 C2.2 13 4.2 11.9 7 12 L17.5 12 C20.8 11.6 22.6 9.4 22.6 8.6' +
      ' C22.6 6.6 21 5.6 19.6 6 C18.4 6.3 17.8 7.4 17.9 8.6 L17.9 12' +
      ' C21.4 12.2 23 13.4 23.4 15.2 Z" fill="#E0C27E" stroke="#9A7B3F" stroke-width=".6" stroke-linejoin="round"/>' +
      // it smiles, because it is winning at its own pace
      '<path d="M21.6 9.6 q.9 .5 1.6 0" fill="none" stroke="#9A7B3F" stroke-width=".5" stroke-linecap="round"/>' +
      '<g class="s-stalkL">' +
      '<path d="M19.4 6.2 L18.2 2.6" stroke="#E0C27E" stroke-width="1.1" stroke-linecap="round"/>' +
      '<circle cx="18" cy="2.2" r="1.05" fill="#F4F7FA" stroke="#9A7B3F" stroke-width=".4"/>' +
      '<circle class="s-eye" cx="18.2" cy="2.2" r=".45" fill="#2A2118"/>' +
      '</g>' +
      '<g class="s-stalkR">' +
      '<path d="M21.2 6 L22.5 2.8" stroke="#E0C27E" stroke-width="1.1" stroke-linecap="round"/>' +
      '<circle cx="22.7" cy="2.4" r="1.05" fill="#F4F7FA" stroke="#9A7B3F" stroke-width=".4"/>' +
      '<circle class="s-eye" cx="22.9" cy="2.4" r=".45" fill="#2A2118"/>' +
      '</g>' +
      '</g>' +
      // THE SHELL — drawn over the body's rear, so a tucking body retracts
      // behind it. A spiral, a rim, and one proud highlight.
      '<g class="s-shell">' +
      '<circle cx="9.6" cy="8.4" r="6.5" fill="#B77F4A" stroke="#6E4A26" stroke-width=".7"/>' +
      '<path d="M9.6 8.4 q2.9 -.4 2.6 2.1 q-.3 2.6 -3.3 2.2 q-3.5 -.5 -3 -4 q.5 -3.9 4.5 -3.5 q4.8 .5 4.3 5.2"' +
      ' fill="none" stroke="#6E4A26" stroke-width=".8" stroke-linecap="round"/>' +
      '<path d="M5 5.6 q1.6 -2 4.2 -2.1" fill="none" stroke="#D9A96B" stroke-width="1" stroke-linecap="round"/>' +
      '</g>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // Gastropod locomotion is a stretch-and-gather pulse, not legs — the body
    // does it and the shell rides along with a lag. Everything transitions
    // slowly: nothing about a snail is abrupt except the tuck.
    css: [
      '.s-all{transform-origin:13px 16px;transition:transform .25s ease}',
      '.s-body{transform-origin:20px 12px;transition:transform .3s ease,opacity .3s ease}',
      '.s-shell{transform-origin:9.6px 8.4px;transition:transform .3s ease}',
      '.s-stalkL{transform-origin:19.4px 6.2px}.s-stalkR{transform-origin:21.2px 6px}',
      '.s-stalkL,.s-stalkR{transition:transform .3s ease}',

      /* the creep: stretch forward, gather up, repeat — the shell rocks a
         half-beat behind, which is what sells the ride-along */
      '@keyframes ycs-creep{0%,100%{transform:scaleX(1)}45%{transform:scaleX(1.06) translateX(.4px)}}',
      '@keyframes ycs-ride{0%,100%{transform:rotate(-1.6deg)}45%{transform:rotate(1.8deg)}}',
      '@keyframes ycs-stalks{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(6deg)}}',
      '[data-state="walk"] .s-body{animation:ycs-creep 1.2s ease-in-out infinite}',
      '[data-state="walk"] .s-shell{animation:ycs-ride 1.2s ease-in-out infinite}',
      '[data-state="walk"] .s-stalkL{animation:ycs-stalks 2.6s ease-in-out infinite}',
      '[data-state="walk"] .s-stalkR{animation:ycs-stalks 2.6s ease-in-out infinite .4s}',
      '[data-state="climb"] .s-body{animation:ycs-creep 1.7s ease-in-out infinite}',
      '[data-state="climb"] .s-shell{animation:ycs-ride 1.7s ease-in-out infinite}',
      '[data-state="hang"] .s-body{animation:ycs-creep 2s ease-in-out infinite}',
      '[data-state="hang"] .s-shell{animation:ycs-ride 2s ease-in-out infinite}',
      /* the chase: the same creep at maximum snail, stalks pinned forward */
      '[data-state="chase"] .s-body{animation:ycs-creep .55s ease-in-out infinite}',
      '[data-state="chase"] .s-shell{animation:ycs-ride .55s ease-in-out infinite}',
      '[data-state="chase"] .s-stalkL,[data-state="chase"] .s-stalkR{transform:rotate(13deg)}',

      /* idle: just the stalks, taking the air */
      '[data-state="idle"] .s-stalkL{animation:ycs-stalks 4.2s ease-in-out infinite}',
      '[data-state="idle"] .s-stalkR{animation:ycs-stalks 4.2s ease-in-out infinite .6s}',

      /* falling: the only correct response — into the shell, which wobbles */
      '@keyframes ycs-wob{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(7deg)}}',
      '[data-state="fall"] .s-body{transform:scale(.12) translateX(-8px);opacity:0}',
      '[data-state="fall"] .s-shell{animation:ycs-wob .5s ease-in-out infinite}',

      /* the landing: the shell takes it, the body re-emerges on the transition */
      '@keyframes ycs-land{0%{transform:scaleY(.82) scaleX(1.1)}60%{transform:scaleY(1.04) scaleX(.97)}100%{transform:none}}',
      '[data-state="land"] .s-all{animation:ycs-land .22s ease-out}',

      /* carried: tucked, and swinging gently in disgrace */
      '@keyframes ycs-dangle{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(8deg)}}',
      '[data-state="drag"] .s-body{transform:scale(.12) translateX(-8px);opacity:0}',
      '[data-state="drag"] .s-all{animation:ycs-dangle .8s ease-in-out infinite}',

      /* idle repertoire */
      '[data-act="rest"] .s-all{transform:translateY(.5px)}',
      /* peer — noticed you: the stalks sweep wide, one after the other */
      '@keyframes ycs-peer{0%,15%{transform:rotate(0)}35%,50%{transform:rotate(-16deg)}70%,85%{transform:rotate(12deg)}100%{transform:rotate(0)}}',
      '[data-act="peer"] .s-stalkL{animation:ycs-peer 3s ease-in-out infinite}',
      '[data-act="peer"] .s-stalkR{animation:ycs-peer 3s ease-in-out infinite .5s}',
      /* tuck — the fall pose, held on purpose, shell rocking itself calm */
      '[data-act="tuck"] .s-body{transform:scale(.12) translateX(-8px);opacity:0}',
      '[data-act="tuck"] .s-shell{animation:ycs-ride 2.4s ease-in-out infinite}',
      /* stretch — the long reach: everything the foot has */
      '@keyframes ycs-stretch{0%,100%{transform:none}45%{transform:scaleX(1.16) translateX(1px)}}',
      '[data-act="stretch"] .s-body{animation:ycs-stretch 3s ease-in-out infinite}',

      /* the signature, tucked under the foot line */
      '.yc-obj-trail{margin-left:-5px;margin-top:-3px}'
    ]
  });
})();
