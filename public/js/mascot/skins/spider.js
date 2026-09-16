/* public/js/mascot/skins/spider.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY, SPIDER FORM — the rowdy one, mark II
 *
 * TOP VIEW, unlike every other form: the others live IN the page, side-on
 * along its ledges — the spider crawls ON it, as though the screen were the
 * floor and it had gotten in somehow. That is `roam: true`: free 2D travel in
 * scurry-and-freeze bursts, edges preferred (spiders are thigmotactic; the
 * furniture tops the engine already scans are its edges) but nothing
 * required, and a drift toward wherever the pointer is working, because the
 * brief for this form is CHAOS — it is supposed to bother you.
 *
 * Its two pranks, both on the never-clickable contract:
 *   · RAPPEL — it anchors a line and rides it down the page; the pointer
 *     touching the silk anywhere cuts it and the spider tumbles.
 *   · WEAVE — it settles on a spot, turning as it works, and builds a web
 *     outward a ring at a time, over ANYTHING, until the pointer breaks it —
 *     the web's break radius always covers its rings, so reaching whatever it
 *     covers destroys it on the way in, and a web over the keyboard-focused
 *     field breaks by itself. Then it scatters, sulks, and starts elsewhere.
 *
 * Rowdy and labelled: the manifest flags it, the picker badges it, the blurb
 * warns in plain words. Send-it-away still works instantly mid-anything.
 *
 * See the header of /js/mascot/engine.js for the full skin contract.
 */
(function () {
  'use strict';
  // The engine bails out entirely under prefers-reduced-motion or a refused
  // localStorage, so this file loading without it is normal, not an error.
  if (!window.Mascot || !window.Mascot.register) return;

  window.Mascot.register({
    id: 'spider',
    name: 'Spider',
    blurb: 'A spider. Roams the whole page, rappels down silk, and builds a web until you break it. Rowdy.',

    // A square-ish box, because a top-view sprite rotates about its centre.
    // FLY_HEAD is the sprite's own size per the convention; no ascent here.
    geom: { W: 22, H: 22, FLY_HEAD: 22 },

    roam: true,

    tune: {
      WALK: 85,              // the scurry (the cadence supplies the chaos)
      RAPPEL: 78,
      WEAVE_CHANCE: 0.45,    // settling usually means business
      RAPPEL_CHANCE: 0.3
    },

    // The roam set: no ledges to fall off, no walls to climb — the whole
    // page is floor. fall is the thrown-and-sliding tumble.
    can: ['walk', 'idle', 'fall', 'land', 'drag', 'leave', 'rappel', 'weave'],

    acts: [
      ['rest', 24], ['twitch', 24], ['tap', 20]
    ],

    // When it notices you, it twitches. Of course it does.
    lookAct: 'twitch',

    // The ever-growing web: ~3s a ring, a dozen rings tops, then it tends the
    // finished work until somebody breaks it. Fixed 120-viewBox — growth
    // happens inside, so the element never moves — and the break radius keeps
    // ahead of the outermost ring (§2a: mouse-over anywhere on it kills it).
    web: {
      ringS: 3.0,
      stages: 12,
      life: 420,             // long enough that the coverage really tiles
      max: 24,               // …across a whole screen, before the cap bites
      breakR0: 8,
      breakDr: 4.6,
      svg: function (CFG, stage) {
        var s = '<svg width="120" height="120" viewBox="0 0 120 120">' +
          '<g fill="none" stroke="#B9C2CF" stroke-width=".7" opacity=".62">';
        var r = 6 + stage * 4.4, k, a;
        // twelve spokes out to the current edge
        var spokes = '';
        for (k = 0; k < 12; k++) {
          a = k * Math.PI / 6;
          spokes += 'M60 60 L' + (60 + Math.cos(a) * r).toFixed(1) + ' ' + (60 + Math.sin(a) * r).toFixed(1) + ' ';
        }
        s += '<path d="' + spokes + '"/>';
        // one ring per stage
        for (k = 1; k <= stage; k++) {
          s += '<circle cx="60" cy="60" r="' + (2 + k * 4.4).toFixed(1) + '"/>';
        }
        s += '</g><circle cx="60" cy="60" r="1.1" fill="#B9C2CF" opacity=".7"/></svg>';
        return s;
      }
    },

    lines: [
      'I have retained myself on a web basis.',
      'Eight legs, one billable mind.',
      'The web is up. Traffic pending.',
      'I do my filings in silk.',
      'Your cursor walked into MY office.',
      'Exhibit W. It glitters. Do not touch.',
      'I never miss a deadline. I hang from them.',
      'Settlement web: everything sticks.',
      'The small print is mine. I spun it.',
      'Your screen is my floor plan.',
      'I sublet the corners.',
      'Startled? That was a scheduled descent.',
      'Motion practice: all eight, in order.',
      'The fly did not appear. Case dismissed.',
      'Adjourned. Mind the web on your way out.'
    ],

    words: { idle: 'settle', weave: 'spin a web', rappel: 'drop a line', tap: 'drum', twitch: 'twitch' },

    // ── The sprite ─────────────────────────────────────────────────────────────
    // 22×22 from above, facing +x (the engine rotates it to its heading):
    // abdomen aft, cephalothorax fore, eight legs in two alternating gait
    // groups — the tripod illusion at four pivots, which is all 22px carries.
    svg:
      '<svg class="p-svg" viewBox="0 0 22 22" width="22" height="22" aria-hidden="true" focusable="false">' +
      '<g class="p-all">' +
      // gait group A: front-left, mid-right, rear-left pattern
      '<g class="p-ga">' +
      '<path d="M13.5 9.4 L16.4 5.6 L20.4 4.2 M11.6 9 L11 4.6 L13.4 1.6 M13.5 12.6 L16.4 16.4 L20.4 17.8 M9.7 13.3 L6.6 17 L3 18.2"' +
      ' fill="none" stroke="#2F2F38" stroke-width="1.05" stroke-linecap="round"/>' +
      '</g>' +
      // gait group B: the alternates
      '<g class="p-gb">' +
      '<path d="M13.5 8.6 L15.2 4.2 L18.2 2 M9.7 8.7 L6.6 5 L3 3.8 M13.5 13.4 L15.2 17.8 L18.2 20 M11.6 13 L11 17.4 L13.4 20.4"' +
      ' fill="none" stroke="#26262E" stroke-width="1.05" stroke-linecap="round"/>' +
      '</g>' +
      // the body over the leg roots
      '<ellipse class="p-abd" cx="7.4" cy="11" rx="5" ry="4.1" fill="#3A3A44" stroke="#1D1D24" stroke-width=".6"/>' +
      '<path d="M4.4 9 q3 -1.6 6 0 M4.4 13 q3 1.6 6 0" fill="none" stroke="#4E4E5A" stroke-width=".8" stroke-linecap="round"/>' +
      '<circle class="p-head" cx="14.2" cy="11" r="3" fill="#3A3A44" stroke="#1D1D24" stroke-width=".6"/>' +
      '<circle class="p-eye" cx="16.2" cy="10" r=".55" fill="#FF6B4A"/>' +
      '<circle class="p-eye" cx="16.2" cy="12" r=".55" fill="#FF6B4A"/>' +
      '<path d="M16.9 10.6 l1.4 -.4 M16.9 11.4 l1.4 .4" stroke="#1D1D24" stroke-width=".55" stroke-linecap="round"/>' +
      '<circle cx="4.6" cy="11" r=".7" fill="#26262E"/>' +          /* spinneret */
      '</g></svg>',

    // ── Styles ─────────────────────────────────────────────────────────────────
    // The engine drives position and heading; the css supplies the gait and
    // the nerves. Everything stepped — a spider does not ease.
    css: [
      '.p-all{transform-origin:11px 11px;transition:transform .12s steps(2,end)}',
      '.p-ga,.p-gb{transform-origin:11px 11px;transition:transform .12s steps(2,end)}',
      '.p-abd{transform-box:fill-box;transform-origin:50% 50%}',

      /* the scuttle: the two gait groups shear against each other */
      '@keyframes ycp-ga{0%,49%{transform:rotate(4deg)}50%,100%{transform:rotate(-4deg)}}',
      '@keyframes ycp-gb{0%,49%{transform:rotate(-4deg)}50%,100%{transform:rotate(4deg)}}',
      '[data-state="walk"] .p-ga{animation:ycp-ga .14s infinite}',
      '[data-state="walk"] .p-gb{animation:ycp-gb .14s infinite}',

      /* idle: mostly still, which from a spider is somehow worse */
      '@keyframes ycp-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}',
      '[data-state="idle"] .p-abd{animation:ycp-breathe 1.5s ease-in-out infinite}',

      /* thrown: legs flare while the engine tumbles the whole sprite */
      '[data-state="fall"] .p-ga{transform:rotate(10deg) scale(1.08)}',
      '[data-state="fall"] .p-gb{transform:rotate(-10deg) scale(1.08)}',

      /* the landing */
      '@keyframes ycp-land{0%{transform:scale(.8)}55%{transform:scale(1.07)}100%{transform:none}}',
      '[data-state="land"] .p-all{animation:ycp-land .2s steps(3,end)}',

      /* carried: all eight objecting at once */
      '@keyframes ycp-wiggle{0%,100%{transform:rotate(6deg)}50%{transform:rotate(-6deg)}}',
      '[data-state="drag"] .p-ga{animation:ycp-wiggle .12s infinite}',
      '[data-state="drag"] .p-gb{animation:ycp-wiggle .12s infinite .06s}',

      /* rappelling: legs drawn in, riding the line the engine draws */
      '[data-state="rappel"] .p-ga{transform:rotate(2deg) scale(.82)}',
      '[data-state="rappel"] .p-gb{transform:rotate(-2deg) scale(.82)}',
      '[data-state="rappel"] .p-abd{animation:ycp-breathe 1s ease-in-out infinite}',

      /* weaving: the engine turns the whole spider; the legs work the silk
         and the abdomen pumps it out */
      '[data-state="weave"] .p-ga{animation:ycp-ga .22s infinite}',
      '[data-state="weave"] .p-gb{animation:ycp-gb .22s infinite}',
      '[data-state="weave"] .p-abd{animation:ycp-breathe .55s ease-in-out infinite}',

      /* idle repertoire */
      '[data-act="rest"] .p-ga,[data-act="rest"] .p-gb{transform:scale(.94)}',
      '@keyframes ycp-rear{0%,100%{transform:rotate(0)}30%,60%{transform:rotate(-8deg) scale(1.05)}}',
      '[data-act="twitch"] .p-all{animation:ycp-rear 1.1s steps(3,end) infinite}',
      '@keyframes ycp-tap{0%,100%{transform:rotate(0)}50%{transform:rotate(6deg)}}',
      '[data-act="tap"] .p-ga{animation:ycp-tap .15s steps(2,end) infinite}',

      /* the webs: centred on the weaving spot; the break is one sharp snap */
      '.yc-obj-web{margin-left:-60px;margin-top:-60px}',
      '@keyframes ycp-snap{0%{transform:scale(1);opacity:.9}100%{transform:scale(1.28);opacity:0}}',
      '.yc-obj-break svg{animation:ycp-snap .3s ease-out forwards}'
    ]
  });
})();
