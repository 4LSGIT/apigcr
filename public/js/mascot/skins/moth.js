/* public/js/mascot/skins/moth.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, MOTH FORM — the one that watches you work
 *
 * Every other form is interested in the page, the floor, or your cursor. This
 * one is interested in the LIGHT, and in an app the light is wherever you are
 * actually working: the field you are typing in. The engine's focusRect() has
 * known how to find that since the spider (a web over the focused input breaks
 * itself, so a keyboard user is never typing under silk); the moth is the same
 * knowledge turned around. Tab to the next field and it comes with you.
 *
 * It orbits the OUTSIDE of whatever it finds, never the middle. That is the
 * whole §2 argument for this form: a moth sitting on the text you are typing
 * would be obstruction, and the engine's lamp branch pushes it off the box
 * rather than trusting an orbit to stay clear.
 *
 * With nothing focused it goes to the brightest large thing on screen, which
 * is not a fallback so much as the same instinct in an empty room.
 *
 * It sheds as it goes — a fading scatter of scales, the trail machinery in
 * the air rather than on the floor.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'moth',
    name: 'Moth',
    blurb: 'Drawn to the light. Follows whatever field you are typing in.',

    geom: { W: 26, H: 20, FLY_HEAD: 20 },

    tune: {
      GRAVITY: 300,          // it lands badly, when it lands at all
      TERMINAL: 140,
      WALK: 20,              // and it walks worse
      LAMP: 205,
      LAMP_CHANCE: 0.75,     // it is nearly always on its way to something lit
      DRIFT_CHANCE: 0.5
    },

    // Drifts, and goes to the light. No climbing, no chasing, no phasing —
    // it wants one thing.
    can: ['walk', 'idle', 'fall', 'land', 'drag', 'leave', 'drift', 'lamp'],

    acts: [
      ['rest', 26], ['quiver', 24], ['fan', 22], ['groom', 18]
    ],

    // When it notices you, the wings shiver.
    lookAct: 'quiver',

    lines: [
      'I go where the light is. That is the whole filing system.',
      'Your cursor is not the light. The field is.',
      'I was drawn here. Literally.',
      'Illuminating, this form.',
      'I bill by the lumen.',
      'Every screen is a window at dusk.',
      'I have read the bright parts.',
      'Objection: insufficient wattage.',
      'The dark mode discourse does not concern me. Much.',
      'I orbit. It is a practice.',
      'Discovery is just looking at the lit thing.',
      'I do not eat the paperwork. That is a different moth.',
      'Focus follows me. Or I follow it.',
      'The bulb was a metaphor. This is not.',
      'Adjourned, towards the nearest lamp.'
    ],

    words: {
      idle: 'settle', drift: 'wander off', lamp: 'go to the light',
      rest: 'settle down', quiver: 'quiver', fan: 'fan the wings', groom: 'groom'
    },

    // The shed: a few scales, gone in moments. Dropped in the air now — the
    // engine's trail covers the flying states for exactly this.
    trail: {
      every: 22,
      life: 2.6,
      max: 26,
      svg: '<svg width="7" height="7" viewBox="0 0 7 7">' +
        '<ellipse cx="2.4" cy="2.6" rx="1.5" ry=".9" fill="#D8C9A8" opacity=".5" transform="rotate(-24 2.4 2.6)"/>' +
        '<ellipse cx="5" cy="4.6" rx="1.1" ry=".7" fill="#EFE3C6" opacity=".42" transform="rotate(18 5 4.6)"/>' +
        '</svg>'
    },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 26×20, facing +x, seen from a little above so both wing pairs read. The
    // forewings are the big triangles, the hindwings peek out beneath, and the
    // whole thing is dust-coloured except the eyes, which are not.
    svg:
      '<svg class="mo-svg" viewBox="0 0 26 20" width="26" height="20" aria-hidden="true" focusable="false">' +
      '<g class="mo-all">' +
      // hindwings first, under everything
      '<g class="mo-hind">' +
      '<path d="M13.6 11.4 C10 12.6 6.6 15.4 5.4 18.6 C8.8 18.8 12 16.6 13.8 13.8 Z"' +
      ' fill="#9C8B6E" stroke="#6E6148" stroke-width=".45" stroke-linejoin="round"/>' +
      '<path d="M13.6 11.4 C17.2 12.6 20.6 15.4 21.8 18.6 C18.4 18.8 15.2 16.6 13.4 13.8 Z"' +
      ' fill="#8F7F63" stroke="#6E6148" stroke-width=".45" stroke-linejoin="round"/>' +
      '</g>' +
      // forewings: the shape that says moth rather than butterfly — swept back
      '<g class="mo-foreL">' +
      '<path d="M13 7.6 C9.4 5.4 4.6 4.4 1.2 6.2 C1.8 10.2 5.6 13 10 13.4 L13.2 11.6 Z"' +
      ' fill="#C6B492" stroke="#6E6148" stroke-width=".5" stroke-linejoin="round"/>' +
      '<path d="M3 6.8 q4 .6 7 3.2 M2.2 8.8 q4.6 .4 8 2.6" fill="none" stroke="#8E7E60" stroke-width=".4" opacity=".7"/>' +
      '<path d="M1.6 6.4 q3.4 -.8 6.6 .6" fill="none" stroke="#EFE3C6" stroke-width=".7" opacity=".55"/>' +
      '</g>' +
      '<g class="mo-foreR">' +
      '<path d="M13 7.6 C16.6 5.4 21.4 4.4 24.8 6.2 C24.2 10.2 20.4 13 16 13.4 L12.8 11.6 Z"' +
      ' fill="#BFAC89" stroke="#6E6148" stroke-width=".5" stroke-linejoin="round"/>' +
      '<path d="M23 6.8 q-4 .6 -7 3.2 M23.8 8.8 q-4.6 .4 -8 2.6" fill="none" stroke="#8E7E60" stroke-width=".4" opacity=".7"/>' +
      '<path d="M24.4 6.4 q-3.4 -.8 -6.6 .6" fill="none" stroke="#EFE3C6" stroke-width=".7" opacity=".55"/>' +
      '</g>' +
      // the fuzzy body
      '<g class="mo-body">' +
      '<ellipse cx="13" cy="10.6" rx="1.9" ry="5.2" fill="#7E7057" stroke="#5A4F3C" stroke-width=".45"/>' +
      '<path d="M11.4 7.6 q1.6 -.8 3.2 0 M11.3 9.4 q1.7 -.8 3.4 0 M11.4 11.2 q1.6 -.8 3.2 0"' +
      ' fill="none" stroke="#A2916F" stroke-width=".5" opacity=".8"/>' +
      '<circle cx="13" cy="5.4" r="2.2" fill="#8A7A5E" stroke="#5A4F3C" stroke-width=".45"/>' +
      // the eyes: the one part that catches the light it is chasing
      '<circle class="mo-eye" cx="11.9" cy="4.8" r=".85" fill="#3A2C1E"/>' +
      '<circle class="mo-eye" cx="14.1" cy="4.8" r=".85" fill="#3A2C1E"/>' +
      '<circle cx="12.1" cy="4.55" r=".3" fill="#FFE9A8"/>' +
      '<circle cx="14.3" cy="4.55" r=".3" fill="#FFE9A8"/>' +
      '</g>' +
      // feathered antennae — the other thing that says moth
      '<g class="mo-ants">' +
      '<path d="M11.9 3.6 C10.4 1.8 8.6 1.2 7.2 1.6" fill="none" stroke="#6E6148" stroke-width=".6" stroke-linecap="round"/>' +
      '<path d="M14.1 3.6 C15.6 1.8 17.4 1.2 18.8 1.6" fill="none" stroke="#6E6148" stroke-width=".6" stroke-linecap="round"/>' +
      '<path d="M10.6 2.5 l-.5 -.9 M9.4 2 l-.4 -.9 M8.2 1.7 l-.3 -.9" stroke="#6E6148" stroke-width=".38" stroke-linecap="round"/>' +
      '<path d="M15.4 2.5 l.5 -.9 M16.6 2 l.4 -.9 M17.8 1.7 l.3 -.9" stroke="#6E6148" stroke-width=".38" stroke-linecap="round"/>' +
      '</g>' +
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // One vocabulary, two speeds: the BLUR (wings beating too fast to read,
    // for anything airborne) and the SET (wings flat and open, for anything
    // at rest). A moth at rest is completely still, which is what makes the
    // flying look as frantic as it does.
    css: [
      '.mo-all{transform-origin:13px 10px;transition:transform .2s ease}',
      '.mo-foreL{transform-origin:13px 9px}.mo-foreR{transform-origin:13px 9px}',
      '.mo-hind{transform-origin:13px 12px}',
      '.mo-body{transform-origin:13px 10px}',
      '.mo-ants{transform-origin:13px 3.6px;transition:transform .25s ease}',
      '.mo-foreL,.mo-foreR,.mo-hind{transition:transform .14s ease}',

      /* the beat: the wings scissor toward the viewer, so they FORESHORTEN
         rather than flap — scaleX about the body line is the whole trick */
      '@keyframes ycmo-beatL{0%,100%{transform:scaleX(1) rotate(-3deg)}50%{transform:scaleX(.26) rotate(7deg)}}',
      '@keyframes ycmo-beatR{0%,100%{transform:scaleX(1) rotate(3deg)}50%{transform:scaleX(.26) rotate(-7deg)}}',
      '@keyframes ycmo-beatH{0%,100%{transform:scaleX(1)}50%{transform:scaleX(.4)}}',
      '@keyframes ycmo-jitter{0%,100%{transform:translate(-.4px,.3px) rotate(-1.5deg)}50%{transform:translate(.4px,-.3px) rotate(1.5deg)}}',

      /* going to the light: the fastest beat, and the body tips into the turn */
      '[data-state="lamp"] .mo-foreL{animation:ycmo-beatL .085s linear infinite}',
      '[data-state="lamp"] .mo-foreR{animation:ycmo-beatR .085s linear infinite}',
      '[data-state="lamp"] .mo-hind{animation:ycmo-beatH .085s linear infinite}',
      '[data-state="lamp"] .mo-all{animation:ycmo-jitter .11s linear infinite}',
      /* drifting: the same wings, unhurried */
      '[data-state="drift"] .mo-foreL{animation:ycmo-beatL .16s linear infinite}',
      '[data-state="drift"] .mo-foreR{animation:ycmo-beatR .16s linear infinite}',
      '[data-state="drift"] .mo-hind{animation:ycmo-beatH .16s linear infinite}',
      /* falling: beating and getting nowhere */
      '[data-state="fall"] .mo-foreL{animation:ycmo-beatL .1s linear infinite}',
      '[data-state="fall"] .mo-foreR{animation:ycmo-beatR .1s linear infinite}',

      /* the ground, where it is useless: wings set flat, a shuffling scuttle */
      '@keyframes ycmo-scuttle{0%,100%{transform:translateY(0)}50%{transform:translateY(.5px)}}',
      '[data-state="walk"] .mo-body{animation:ycmo-scuttle .2s linear infinite}',
      '[data-state="walk"] .mo-foreL{transform:rotate(-6deg)}',
      '[data-state="walk"] .mo-foreR{transform:rotate(6deg)}',
      '@keyframes ycmo-land{0%{transform:scale(1.1)}60%{transform:scale(.97)}100%{transform:none}}',
      '[data-state="land"] .mo-all{animation:ycmo-land .18s ease-out}',

      /* at rest it is perfectly, unnervingly still */
      '[data-state="idle"] .mo-foreL{transform:rotate(-4deg)}',
      '[data-state="idle"] .mo-foreR{transform:rotate(4deg)}',

      /* carried: wings clamped shut, antennae back */
      '[data-state="drag"] .mo-foreL{transform:scaleX(.5) rotate(-14deg)}',
      '[data-state="drag"] .mo-foreR{transform:scaleX(.5) rotate(14deg)}',
      '[data-state="drag"] .mo-ants{transform:scaleY(.6)}',

      /* idle repertoire */
      '[data-act="rest"] .mo-foreL{transform:rotate(-2deg)}',
      '[data-act="rest"] .mo-foreR{transform:rotate(2deg)}',
      /* quiver — the small, constant shiver of a moth that has just landed */
      '@keyframes ycmo-quiver{0%,100%{transform:rotate(-2deg) scaleX(1)}50%{transform:rotate(-2deg) scaleX(.93)}}',
      '@keyframes ycmo-quiverR{0%,100%{transform:rotate(2deg) scaleX(1)}50%{transform:rotate(2deg) scaleX(.93)}}',
      '[data-act="quiver"] .mo-foreL{animation:ycmo-quiver .07s linear infinite}',
      '[data-act="quiver"] .mo-foreR{animation:ycmo-quiverR .07s linear infinite}',
      /* fan — wings open wide and slow, showing the whole pattern */
      '@keyframes ycmo-fanL{0%,100%{transform:rotate(-3deg) scale(1)}50%{transform:rotate(-13deg) scale(1.08)}}',
      '@keyframes ycmo-fanR{0%,100%{transform:rotate(3deg) scale(1)}50%{transform:rotate(13deg) scale(1.08)}}',
      '[data-act="fan"] .mo-foreL{animation:ycmo-fanL 2.6s ease-in-out infinite}',
      '[data-act="fan"] .mo-foreR{animation:ycmo-fanR 2.6s ease-in-out infinite}',
      /* groom — it drags the antennae down through its legs, as they do */
      '@keyframes ycmo-groom{0%,100%{transform:rotate(0)}30%,60%{transform:rotate(16deg) translateY(1.4px)}}',
      '[data-act="groom"] .mo-ants{animation:ycmo-groom 2.2s ease-in-out infinite}',
      '[data-act="groom"] .mo-body{transform:rotate(-4deg)}',

      /* the shed, centred on where it was */
      '.yc-obj-trail{margin-left:-3px;margin-top:-3px}'
    ]
  });
})();
