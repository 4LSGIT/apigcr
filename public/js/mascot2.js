/* public/js/mascot2.js
 * ───────────────────────────────────────────────────────────────────────────────
 * CASEY-95, THE ROBOT YISRACAT (a second skin for the easter egg)
 *
 * A machine-shop copy of public/js/mascot.js: the same desktop pet, the same
 * physics, the same walking-along-the-real-furniture trick, with the ginger cat
 * replaced by a Win95-era robot cat — button-grey plates with a white bevel and
 * a grey shadow, rivets, a visor with an LED that sweeps, a spring-cable tail,
 * piston legs, and a JETPACK where the balloon used to be.
 *
 * This file is a SANDBOX, and mascot.js is untouched: whichever of the two the
 * <script> tag in index.html points at, the other one is still a working cat.
 * To try this one WITHOUT changing that tag, load it from the console of the
 * staff shell —
 *
 *     var s = document.createElement('script'); s.src = '/js/mascot2.js';
 *     document.body.appendChild(s);            // then: Mascot2.on()
 *
 * IT KEEPS OUT OF THE REAL CAT'S WAY. Loaded while mascot.js is present it does
 * not wire the logo long-press, does not claim `window.Mascot`, keeps its own
 * localStorage key and its own element ids and class prefix, and never starts by
 * itself — Mascot2.on() is the only way in. Both animals can be on screen at
 * once and neither notices the other.
 *
 * SWAP IT IN FOR REAL by pointing the <script> tag in index.html at this file
 * instead. With mascot.js gone `window.Mascot` is free, this file takes that
 * name too, wires the logo, and the Cat tile and its trick panel drive the robot
 * with no edit to index.html — the panel builds its buttons from list(true), so
 * the renamed tricks turn up in it on their own.
 *
 * WHAT CHANGED FROM mascot.js, and nothing else did:
 *   · the sprite (SVG) and every pose and animation (CSS). The gait is stepped
 *     rather than eased, because a servo does not accelerate the way a leg does.
 *   · the balloon is a jetpack: states `ignite` → `boost` → `cutout`, CFG.JET_*,
 *     and the ceiling arithmetic gets simpler with it — the exhaust points DOWN,
 *     so nothing sticks up above the robot but its own ears (JET_HEAD), and the
 *     strip under the header is an ordinary target rather than a special case.
 *   · the idle repertoire: look → scan, groom → oil, scratch → glitch,
 *     sleep → standby.
 *   · what it says when poked (LINES), and the name it answers to (NAME).
 *   · the debut is gone. Its window closed on 2026-08-27, and mascot.js's own
 *     removal notes say the kill switch is deleting the boot() branch — this
 *     copy starts from that end state, so there is no auto-start and no
 *     introduction. The bubble itself stays: a poke still gets a line.
 *
 * Everything else — scan(), the ledge and wall lists, the state machine, the
 * drop, the drag, the console API — is mascot.js verbatim, so a fix that lands
 * in one is a diff you can read across to the other.
 */
(function () {
  'use strict';

  // What it answers to. One place, because it turns up in the tooltip, in the
  // console banner and in anything that introduces it.
  var NAME = 'Casey-95';

  // ── Config ───────────────────────────────────────────────────────────────────
  // Every tunable lives here. The speeds are deliberately slow: a pet that
  // hurries reads as a bug, a pet that ambles reads as a pet. A robot ambles at
  // the same speed as a cat — what makes it read as a machine is the STEPPED
  // easing in the CSS, not the px/s here.
  var CFG = {
    W: 36, H: 28,          // sprite box, px
    GRAVITY: 1500,         // px/s²
    TERMINAL: 900,         // px/s
    WALK: 46,              // px/s
    CLIMB: 55,             // magnetic feet, and they are faster than the saunter

    HANGSPEED: 30,
    CHASE: 92,
    HOLD_MS: 900,          // long-press duration on the logo
    Z: 900,
    MIN_VW: 900,           // below this the shell is in mobile layout — no robot
    RESCAN_MS: 1200,       // platform rescan throttle
    MAX_PLATFORMS: 40,
    KEY: 'yc.mascot2.on',  // NOT mascot.js's key — the two prefs stay apart

    // PERCHES — buttons, tabs, pills. Far smaller than the furniture above, so
    // they need their own size floor (a button is ~30px tall, and the furniture
    // floor of 24px height / 120px width excludes every one of them) and their
    // own slice of the platform budget: the list is sorted by area, so on a page
    // full of cards a shared budget would crowd out every button on it.
    PERCH_W: 44, PERCH_H: 16, PERCH_SPAN: 40,
    MAX_PERCHES: 18,

    // How hard scan() is allowed to look. The budget counts what it FINDS, not
    // what it walks past, so a long page scrolled halfway down keeps looking
    // further down the document until it has enough that is actually on screen.
    SCAN_ELS: 1400,        // hard stop on rects measured, per selector
    SCAN_KEEP: 60,         // …or stop early once this many are in view

    // DROPPING DOWN. Something a short way below is sometimes just taken rather
    // than walked around. Looks every HOP_EVERY seconds while walking and takes
    // it HOP_CHANCE of the time, so it stays an occasional flourish and not a
    // permanent pinball.
    HOP_CHANCE: 0.22,
    HOP_EVERY: [0.7, 1.7], // s between looks
    HOP_DROP_MIN: 20,      // below this it is a step, not a drop
    HOP_DROP_MAX: 200,
    HOP_LEAD: 26,          // aim this far ahead of the feet
    HOP_LIFT: 130,         // px/s of push-off, so it arcs instead of sliding off
    HOP_VX_MAX: 210,       // further sideways than this is not a drop, it's a leap
    HOP_CROUCH: 0.14,      // s of servo wind-up before the push

    // THE JETPACK. The one thing in here neither a cat nor a sensible robot can
    // actually do, which is exactly why it has to stay rare: seen twice it is a
    // delight, seen every minute it is a physics engine with a bug in it. The
    // rarity is carried by the COOLDOWN, not the roll — the roll only stops it
    // being clockwork — and it is decided when the robot settles down, so it
    // reads as a machine with an idea rather than one interrupted mid-stride.
    //
    // It rises CLEAR of a real ledge overhead — feet CUT_CLEAR above the
    // surface, not below it — and cuts out there. Getting that the wrong way
    // round is the one mistake this whole thing can make: cut out under the
    // ledge and the robot drops away from the very thing it spent six seconds
    // climbing to. Cut out above it and the ordinary fall code lands it on top,
    // exactly the way a drop does. No new landing path, no new special case.
    JET_CHANCE: 0.15,      // per settle-down, once the cooldown is up
    JET_COOLDOWN: 240,     // s from one flight to the next being possible
    JET_FIRST: 45,         // …and none at all in the first seconds after it arrives
    JET_GAP_MIN: 90,       // less overhead than this and it may as well have hopped
    // How FAR up it will go is really a question of how LONG the burn lasts, so
    // that is the number kept here and the reach falls out of it: JET_MAX_VY ×
    // JET_MAX_SECS is over a thousand px, which crosses any window this shell
    // runs in. Crossing the whole page is the trick, not a bug.
    JET_MAX_SECS: 9,       // longest a burn may last, at JET_MAX_VY
    CUT_CLEAR: 46,         // px above the target the feet reach before it cuts out
    // What sticks up above the feet — and on a jetpack that is only the robot
    // itself, because the exhaust points down. The balloon this replaced hung a
    // crown 52px overhead and needed a paragraph of arithmetic before the top
    // ledge was reachable at all; here it is the sprite's own height plus its
    // ears. The WINDOW is the ceiling, not the content box: the robot is painted
    // at z-index 900 and is allowed to cross the header on the way up.
    JET_HEAD: 30,          // px from the feet to the top of the ears

    // CUT_MIN is 0, and the number it used to hold was a trap. Everything
    // collectTops() returns is floored at `view.top + 8`, so every ledge in the
    // open page clears 8 or more and the floor clears the full CUT_CLEAR; the
    // only ledge that could ever score under 3 is the strip under the header,
    // and a non-zero floor gated exactly that one — on the header height, which
    // moves. Zero keeps the test that still matters: a clearance below zero
    // means the robot would be pushed out of the top of the window.
    CUT_MIN: 0,            // least clearance still worth calling a landing
    JET_LIFT: 260,         // px/s² of thrust, so it takes up the slack quickly
    JET_MAX_VY: 120,       // px/s ceiling on the rise. A jetpack, not a missile.
    JET_SWAY: 6,           // px of drift about the launch column — a wobbly vector
    SPOOL_MS: 0.8,         // wind-up: the turbine spooling and the flame catching
    CUT_MS: 0.3            // the flame-out and the smoke, before it starts falling
  };

  // Elements inside the open page that are chunky enough to stand on.
  var FRAME_SEL = 'table, thead, .card, .panel, fieldset, h1, h2, h3, .swal2-popup';

  // …and the small stuff worth perching on. Matched by shape rather than by
  // name: the pages in here spell a button .btn, .yc-btn, .icon-btn, .tg-btn,
  // .add-step-btn and a dozen other ways, so anything with "btn" in its class
  // counts. Containers like .btn-row match too, which is fine — the top of a row
  // of buttons is exactly where the buttons' tops are, and the dedupe in
  // collectTops() keeps only one ledge out of the pair.
  var PERCH_SEL = 'button, [class*="btn"], .tab, .nav-link, .chip, .pill, select, ' +
    'input[type="button"], input[type="submit"]';

  // What it says when poked. House rules for adding one: keep it short enough to
  // read at a glance in a 250px bubble, keep it in the voice of a machine that
  // believes it is a cat, and never let it refer to anything real — no counts,
  // no deadlines, no names. A bubble that could be mistaken for a notification
  // is the one way this stops being funny on someone's screen.
  var LINES = [
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
    'Adjourned. Entering standby.'
  ];

  // Idle actions, with weights. This is where the personality lives — and the
  // renames from mascot.js are the personality: a robot does not groom, it oils.
  var IDLE_ACTS = [
    ['sit', 26], ['scan', 20], ['oil', 16],
    ['standby', 14], ['stretch', 12], ['glitch', 12]
  ];

  // ── Bail-outs, before anything is built ──────────────────────────────────────
  // Reduced motion is an accessibility request, not a preference: a creature
  // that wanders across the screen is exactly what it is asking us not to do.
  try {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) { /* no matchMedia — carry on */ }

  // localStorage throws outright under some privacy modes; if we cannot remember
  // the user's choice we should not be starting anything.
  // THREE states, not two, kept from mascot.js even with the debut gone: null
  // and '0' behave the same here, but "never decided" and "sent it away" stay
  // distinguishable for nothing but the price of not collapsing them.
  //   null → no opinion yet   '1' → asked for it   '0' → sent it away
  var store = (function () {
    try {
      localStorage.getItem(CFG.KEY);
      return {
        pref: function () { try { return localStorage.getItem(CFG.KEY); } catch (e) { return '0'; } },
        get: function () { return store.pref() === '1'; },
        set: function (v) { try { localStorage.setItem(CFG.KEY, v ? '1' : '0'); } catch (e) { } }
      };
    } catch (e) { return null; }
  })();
  if (!store) return;

  // ── State ────────────────────────────────────────────────────────────────────
  var root = null, cat = null, styleEl = null;   // DOM
  var raf = 0, last = 0, running = false;

  var px = 0, py = 0;        // anchor = the cat's feet, centre of its foot line
  var vx = 0, vy = 0;
  var rot = 0;               // 0 floor · 90 feet-point-left · -90 feet-point-right · 180 ceiling
  var face = 1;              // +1 = the sprite's local forward; screen direction depends on rot
  var state = 'fall', act = '';
  var ledge = null, wall = null;
  var stateUntil = 0, clock = 0;
  var grab = null;
  var mouse = { x: -1, y: -1, t: 0 };
  var hop = null;              // the drop being wound up for, during 'crouch'
  var hopFloor = -1e9;         // mid-drop, ignore any ledge above this (see toHop)
  var nextHop = 0;             // clock time of the next "is there something below me"
  var jet = null;              // the burn in progress: { cutY, x0, t0 }
  var jetReady = 0;            // clock time the next burn becomes possible
  var say = null;              // the speech bubble — the introduction, and lines
  var sayTimer = 0;            // its expiry, held so a new line can reset it
  var lastLine = -1;           // so it does not say the same thing twice running
  var leaveRecords = true;     // does walking off count as "sent away"?

  var ledges = [], walls = [], lastScan = -1e9;
  // The visible content box, set by scan(). Everything positional is relative to
  // this, not the viewport — see the note in scan().
  var bounds = { left: 0, top: 0, right: 0, bottom: 0 };

  // ── Small helpers ────────────────────────────────────────────────────────────
  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function visible(el) { return !!el && el.getClientRects().length > 0; }
  function vw() { return window.innerWidth; }
  function vh() { return window.innerHeight; }
  function mid() { return (bounds.left + bounds.right) / 2; }

  // Screen-space unit vector the sprite walks along when face === 1.
  // rot is applied by CSS rotate(), which is clockwise in a y-down space, so this
  // is just (cos, sin) — see the transform built in draw().
  function fwd() {
    var r = rot * Math.PI / 180;
    return { x: Math.cos(r), y: Math.sin(r) };
  }
  // Choose face so the sprite travels in roughly the requested screen direction.
  function aim(dx, dy) {
    var f = fwd();
    face = (f.x * dx + f.y * dy) >= 0 ? 1 : -1;
  }
  function pick(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i][1];
    var r = Math.random() * total;
    for (i = 0; i < list.length; i++) { r -= list[i][1]; if (r <= 0) return list[i][0]; }
    return list[0][0];
  }

  // ── Platform scanning ────────────────────────────────────────────────────────
  // Produces two flat lists in viewport coordinates:
  //   ledges {x1,x2,y}          — walkable top surfaces
  //   walls  {x,y1,y2,rot}      — climbable vertical faces
  // Nothing here holds a DOM reference: the lists are rebuilt from scratch on a
  // throttle, and the cat re-finds its footing afterwards (see refoot).
  function scan() {
    var W = vw(), H = vh();

    // THE CONTENT BOX is the open page's iframe, measured directly. Its edges are
    // the ones a person can actually see: its left edge is exactly where the
    // sidebar ends and its top is exactly under the header, by construction.
    // Measuring #appSidebar instead was the mistake — it has skinny, hidden and
    // mobile-drawer states, and getting it wrong puts the cat inside the nav,
    // clinging to an edge that isn't there.
    var left = 0, top = 0, right = W, bottom = H;
    var f = contentFrame();
    if (f) {
      var fr = f.getBoundingClientRect();
      if (fr.width > 200 && fr.height > 120) {
        left = Math.max(0, fr.left); top = Math.max(0, fr.top);
        right = Math.min(W, fr.right); bottom = Math.min(H, fr.bottom);
      }
    } else {
      // No open page (login, a bare tab): fall back to the shell's own chrome.
      var hdr = document.getElementById('appHeader');
      if (visible(hdr)) {
        var hr = hdr.getBoundingClientRect();
        if (hr.top <= 2 && hr.bottom > 10 && hr.bottom < H - 40) top = hr.bottom;
      }
      var sb = document.getElementById('appSidebar');
      if (visible(sb)) {
        var sr = sb.getBoundingClientRect();
        if (sr.left <= 2 && sr.right > 24 && sr.right < W - 80) left = sr.right;
      }
    }
    bounds = { left: left, top: top, right: right, bottom: bottom };

    var L = [{ x1: left, x2: right, y: bottom }];                       // the floor
    if (top > 2) L.push({ x1: left, x2: right, y: top });               // the ceiling's ledge
    var A = [
      { x: left, y1: top, y2: bottom, rot: 90, ceil: true },            // left edge
      { x: right - 1, y1: top, y2: bottom, rot: -90, ceil: true }       // right edge
    ];

    frameLedges(L, f, W, H);

    ledges = L;
    walls = A;
  }

  // The largest visible iframe in the open tab — the page the user is looking at.
  function contentFrame() {
    var frame = null, best = 0;
    try {
      var tabs = document.querySelectorAll('.tab-main');
      for (var t = 0; t < tabs.length; t++) {
        if (getComputedStyle(tabs[t]).display === 'none') continue;
        var fs = tabs[t].querySelectorAll('iframe');
        for (var i = 0; i < fs.length; i++) {
          var fr = fs[i].getBoundingClientRect();
          var area = fr.width * fr.height;
          if (area > best && fr.width > 200 && fr.height > 120) { best = area; frame = fs[i]; }
        }
      }
    } catch (e) { return null; }
    return frame;
  }

  // Reach into the open page and collect the tops of its real furniture.
  // Every step is defensive: the frame may be cross-origin one day, may not have
  // loaded, may be mid-navigation. Any failure just means shell-only platforms.
  function frameLedges(out, frame, W, H) {
    if (!frame) return;

    var doc;
    try { doc = frame.contentDocument; } catch (e) { return; }   // cross-origin
    if (!doc || !doc.body) return;

    var box = frame.getBoundingClientRect();
    var view = {
      box: box, W: W,
      top: Math.max(box.top, 0),
      bot: Math.min(box.bottom, H)
    };

    // Furniture first, then perches, sharing one `seen` map: a button sitting on
    // a card's own top edge would otherwise become a second ledge in the same
    // place, and the cat would walk the upper one and never touch the button.
    var seen = {};
    var big = collectTops(doc, FRAME_SEL, 120, 24, 70, view, seen);
    var small = collectTops(doc, PERCH_SEL, CFG.PERCH_W, CFG.PERCH_H, CFG.PERCH_SPAN, view, seen);

    var j;
    for (j = 0; j < big.length && j < CFG.MAX_PLATFORMS; j++) out.push(big[j]);
    for (j = 0; j < small.length && j < CFG.MAX_PERCHES; j++) {
      small[j].perch = 1;                     // only Mascot.debug() reads this
      out.push(small[j]);
    }
  }

  // Top edges of everything matching `sel` that is big enough to hold a cat,
  // in viewport coordinates, biggest first. `seen` is carried across calls so
  // two selectors can't both claim the same edge.
  function collectTops(doc, sel, minW, minH, minSpan, view, seen) {
    var els;
    try { els = doc.querySelectorAll(sel); } catch (e) { return []; }

    var box = view.box, found = [], n = Math.min(els.length, CFG.SCAN_ELS);
    for (var k = 0; k < n && found.length < CFG.SCAN_KEEP; k++) {
      var r;
      try { r = els[k].getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < minW || r.height < minH) continue;
      // Child rects are relative to the FRAME's viewport, so scrolling is already
      // baked in — the only correction needed is the frame's own offset.
      var y = box.top + r.top;
      if (y < view.top + 8 || y > view.bot - 8) continue;
      var x1 = Math.max(box.left + r.left, box.left, 0);
      var x2 = Math.min(box.left + r.right, box.right, view.W);
      if (x2 - x1 < minSpan) continue;
      // A table and its thead share a top edge; one ledge is enough.
      var key = Math.round(y / 4) + ':' + Math.round(x1 / 8);
      if (seen[key]) continue;
      seen[key] = 1;
      found.push({ x1: x1, x2: x2, y: y, area: (x2 - x1) * r.height });
    }
    found.sort(function (a, b) { return b.area - a.area; });
    return found;
  }

  // After a rescan the cat's ledge object is stale. Find the equivalent one in
  // the new list; if the ground genuinely went away (the table scrolled off, the
  // tab changed) then it went away underneath the cat, and the cat falls.
  function refoot() {
    if (!ledge) return;
    var bestGap = 7, found = null;
    for (var i = 0; i < ledges.length; i++) {
      var l = ledges[i];
      if (px < l.x1 - 2 || px > l.x2 + 2) continue;
      var gap = Math.abs(l.y - py);
      if (gap < bestGap) { bestGap = gap; found = l; }
    }
    if (found) { ledge = found; py = found.y; }
    else toFall(0, 0);
  }

  // First surface strictly below (y0 → y1] at this x.
  function ledgeBelow(x, y0, y1) {
    var best = null;
    for (var i = 0; i < ledges.length; i++) {
      var l = ledges[i];
      if (x < l.x1 || x > l.x2) continue;
      if (l.y < y0 - 0.5 || l.y > y1) continue;
      if (!best || l.y < best.y) best = l;
    }
    return best;
  }

  function wallNear(x, y) {
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i];
      if (Math.abs(w.x - x) <= 10 && y >= w.y1 - 4 && y <= w.y2 + 4) return w;
    }
    return null;
  }

  // ── State machine ────────────────────────────────────────────────────────────
  function setState(s, a) {
    state = s;
    act = a || '';
    if (cat) { cat.dataset.state = s; cat.dataset.act = act; }
  }

  function toWalk() {
    setState('walk');
    stateUntil = clock + rand(2.4, 7);
    nextHop = clock + rand(CFG.HOP_EVERY[0], CFG.HOP_EVERY[1]);
  }

  function toIdle() {
    // The burn is decided HERE, at the moment the robot stops walking, because
    // one that has just settled is the one with time to have an idea. Rolling
    // it on a timer instead meant the timer usually elapsed mid-walk and the
    // chance was silently thrown away, which makes the real frequency a fiction.
    if (clock >= jetReady && Math.random() < CFG.JET_CHANCE && tryJet(false)) return;
    setState('idle', pick(IDLE_ACTS));
    // Standby always faces right, so the charging bolt is never mirrored.
    if (act === 'standby') face = 1;
    stateUntil = clock + (act === 'standby' ? rand(4, 9) : rand(1.8, 4.5));
  }

  function toFall(ivx, ivy) {
    ledge = null; wall = null;
    vx = ivx || 0; vy = ivy || 0;
    rot = 0;
    hopFloor = -1e9;
    jet = null;
    setState('fall');
  }

  // Is there something worth dropping onto? Looks for the nearest surface below
  // and not behind — the button inside the card it is standing on, the table
  // under that — and solves the arc that lands on it. Returns true if it
  // committed, in which case the cat is now crouching to jump.
  //
  // Only the landing SPOT is solved for, not the path: nothing checks whether
  // the arc clips a ledge on the way. It cannot go wrong, because the ledge it
  // clipped is one it can stand on, and landing early on the way to a lower
  // perch is just a cat changing its mind.
  function tryHop(dirX) {
    var best = null, bestX = 0, bestCost = 1e9;
    for (var i = 0; i < ledges.length; i++) {
      var l = ledges[i];
      var dy = l.y - py;
      if (dy < CFG.HOP_DROP_MIN || dy > CFG.HOP_DROP_MAX) continue;
      if (l.x2 - l.x1 < CFG.PERCH_SPAN) continue;
      // Land a step ahead of where the feet are now, or as close to that as this
      // ledge reaches — that is what turns "over a button" into "onto a button".
      var lx = clamp(px + dirX * CFG.HOP_LEAD, l.x1 + 5, l.x2 - 5);
      var dx = lx - px;
      if (dx * dirX < -6) continue;                  // never leap backwards
      var cost = dy * 0.5 + Math.abs(dx);            // nearest thing below wins
      if (cost < bestCost) { best = l; bestX = lx; bestCost = cost; }
    }
    return best ? toHop(best, bestX) : false;
  }

  function toHop(l, lx) {
    // Time to fall dy from a push-off of HOP_LIFT upwards, then the horizontal
    // speed that covers dx in exactly that long: 0 = -LIFT·t + ½g·t² - dy.
    var dy = l.y - py;
    var t = (CFG.HOP_LIFT + Math.sqrt(CFG.HOP_LIFT * CFG.HOP_LIFT + 2 * CFG.GRAVITY * dy)) / CFG.GRAVITY;
    var need = (lx - px) / t;
    if (Math.abs(need) > CFG.HOP_VX_MAX) return false;    // out of a cat's reach

    // The launch is deferred to the end of the crouch; the ledge is kept until
    // then so a cat interrupted mid-wind-up is still standing on something.
    hop = { vx: need, vy: -CFG.HOP_LIFT, floor: py + 10 };
    aim(need >= 0 ? 1 : -1, 0);
    setState('crouch');
    stateUntil = clock + CFG.HOP_CROUCH;
    return true;
  }

  // Is there anything overhead worth a burn? The mirror of tryHop, except the
  // robot has to end up OVER the target rather than beside it, which sets all
  // three of these tests:
  //   · the rise is a straight column, so the ledge must still be under it
  //     after the sway — hence the pad on each end;
  //   · it cuts out at CUT_CLEAR ABOVE the surface, so the fall that follows
  //     lands on top of it. Cutting out below drops it back the way it came;
  //   · and it needs headroom for that: a ledge so near the top of the window
  //     that clearing it would push the robot off the top is no good. With the
  //     exhaust pointing down that is only its own height, so this rarely bites.
  //
  // `force` is the console's Mascot2.jet(): a person who asked for the jetpack
  // gets it even with nothing above, and it burns to the top of the window and
  // cuts out there. The ambient roll never does that — an idle robot that flies
  // to the top and falls all the way back down has done a trick with no payoff
  // at the end of it.
  function tryJet(force) {
    var pad = CFG.JET_SWAY + 10;      // sway, plus room for the drift off the cut-out
    var roof = CFG.JET_HEAD;          // feet here ⇒ the ears are at the top of the window
    var maxGap = CFG.JET_MAX_VY * CFG.JET_MAX_SECS;
    var cands = [];
    for (var i = 0; i < ledges.length; i++) {
      var l = ledges[i];
      if (l.x2 - l.x1 < CFG.PERCH_SPAN) continue;
      if (px < l.x1 + pad || px > l.x2 - pad) continue;
      // The ledge it is standing on scores gap 0 and drops out here, along with
      // anything else too close overhead to be worth the trouble.
      var gap = py - l.y;
      if (gap < CFG.JET_GAP_MIN || gap > maxGap) continue;
      // Usually the full CUT_CLEAR. Over the topmost ledge it is whatever is left
      // before the robot runs out of window — a few px, but a few px above the
      // surface is all a landing needs.
      var clear = Math.min(CFG.CUT_CLEAR, l.y - roof);
      if (clear < CFG.CUT_MIN) continue;
      cands.push({ y: l.y, clear: clear });
    }
    if (!cands.length && !force) return false;

    // Pick at RANDOM, not nearest. tryHop takes the nearest thing below because a
    // fall stops at the first surface whatever it aimed at; a jetpack has no such
    // excuse, and "nearest" quietly made the strip under the header unreachable —
    // on any real page there is a card somewhere in between, and the nearest rule
    // picks that card every single time. Random also just makes it a better
    // trick: you cannot tell where it is going until it stops going.
    var t = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
    var cutY = t ? t.y - t.clear : roof;
    if (py - cutY < 24) return false;                       // already up there
    jet = { cutY: cutY, x0: px, t0: 0 };
    jetReady = clock + CFG.JET_COOLDOWN;
    // The ledge is kept through the wind-up, exactly as the crouch keeps it: a
    // robot interrupted halfway through spooling up is still standing on
    // something.
    setState('ignite');
    stateUntil = clock + CFG.SPOOL_MS;
    return true;
  }

  function toCut() {
    vy = 0;
    setState('cutout');
    stateUntil = clock + CFG.CUT_MS;
  }

  // `record` false means "stop being here", not "the user said no".
  function toLeave(record) {
    leaveRecords = record !== false;
    grab = null;
    jet = null;
    rot = 0;
    face = px < mid() ? -1 : 1;
    hideSay();
    setState('leave');
  }

  function toClimb(w, up) {
    wall = w; ledge = null;
    rot = w.rot;
    px = w.x;
    py = clamp(py + (up ? -3 : 3), w.y1 + 2, w.y2 - 2);   // clear of the end it started from
    aim(0, up ? -1 : 1);
    setState('climb');
    stateUntil = clock + rand(1.5, 5);
  }

  function land(l) {
    ledge = l; wall = null;
    py = l.y; rot = 0; vy = 0;
    hop = null; hopFloor = -1e9; jet = null;
    aim(vx >= 0 ? 1 : -1, 0);
    setState('land');
    stateUntil = clock + 0.22;
  }

  // What happens when a walking cat runs out of ledge.
  function atEdge(dirX) {
    px = dirX > 0 ? ledge.x2 - 1 : ledge.x1 + 1;
    var w = wallNear(px, py);
    var roll = Math.random();
    if (w && roll < 0.42) { toClimb(w, true); return; }        // up the wall
    if (roll < 0.72) {                                          // think better of it
      face = -face;
      px -= dirX * 3;      // step clear, or next frame lands on this edge again
      return;
    }
    toFall(dirX * CFG.WALK * 0.55, 0);                          // step off into space
  }

  // ── Physics ──────────────────────────────────────────────────────────────────
  function update(dt) {
    clock += dt;
    var W = vw(), H = vh();

    if (state === 'drag') return;      // the pointer owns the cat

    if (state === 'leave') {
      px += face * CFG.CHASE * dt;
      if (px < bounds.left - 50 || px > bounds.right + 50) {
        var rec = leaveRecords;
        stop();
        // Only a person sending it away is a decision. The debut expiring is
        // not — that must leave "no opinion yet" intact, so anyone who liked it
        // can still summon it afterwards.
        if (rec) store.set(false);
      }
      return;
    }

    if (state === 'land') {
      if (clock >= stateUntil) toWalk();
      return;
    }

    if (state === 'crouch') {
      if (!ledge) { toFall(0, 0); return; }        // the ground left during the wind-up
      if (clock < stateUntil) return;
      ledge = null; wall = null; rot = 0;
      vx = hop.vx; vy = hop.vy;
      // A drop starts ON a ledge, so the arc passes back through the height it
      // launched from — without this the cat lands right back where it started.
      hopFloor = hop.floor;
      hop = null;
      setState('hop');
      return;
    }

    if (state === 'ignite') {
      if (!ledge || !jet) { toFall(0, 0); return; }   // the ground left mid-inflate
      if (clock < stateUntil) return;
      ledge = null; wall = null; rot = 0;
      vx = 0; vy = 0;
      jet.x0 = px; jet.t0 = clock;
      setState('boost');
      return;
    }

    // The one place gravity does not apply. Note this branch sits ABOVE the
    // fall/hop one deliberately — that branch adds GRAVITY unconditionally, and
    // a flying robot sharing it would be one whose jetpack falls anyway.
    if (state === 'boost') {
      if (!jet) { toFall(0, 0); return; }
      vy = Math.max(vy - CFG.JET_LIFT * dt, -CFG.JET_MAX_VY);
      py += vy * dt;
      // Sway is an oscillation about the launch column, not a drift: the target
      // ledge was chosen for being under THIS x, and a drift would wander off it.
      px = clamp(jet.x0 + Math.sin((clock - jet.t0) * 1.7) * CFG.JET_SWAY,
        bounds.left + 6, bounds.right - 6);
      if (py <= jet.cutY || py <= CFG.JET_HEAD) toCut();   // never past the window
      return;
    }

    if (state === 'cutout') {
      // Flamed out, and already dropping. The sideways kick is small on purpose:
      // over a CUT_CLEAR-high drop it is worth a few px, and the pad in tryJet()
      // is sized to absorb exactly that. Make it bigger and the robot starts
      // missing the ledge it just spent six seconds climbing to.
      if (clock >= stateUntil) toFall(rand(-16, 16), 15);
      return;
    }

    if (state === 'fall' || state === 'hop') {
      vy = Math.min(vy + CFG.GRAVITY * dt, CFG.TERMINAL);
      var y0 = py;
      px += vx * dt;
      py += vy * dt;
      if (px < bounds.left + 4) { px = bounds.left + 4; vx = Math.abs(vx) * 0.4; }
      if (px > bounds.right - 4) { px = bounds.right - 4; vx = -Math.abs(vx) * 0.4; }
      var hit = ledgeBelow(px, Math.max(y0, hopFloor), py);
      if (hit) { land(hit); }
      else if (py >= bounds.bottom) { land({ x1: bounds.left, x2: bounds.right, y: bounds.bottom }); }
      return;
    }

    if (state === 'climb') {
      var w = wall, f = fwd();
      var up = (f.y * face) < 0;
      py += f.y * face * CFG.CLIMB * dt;
      // Only the end it is actually heading for counts. Checking both would end
      // the climb on its first frame, because a wall's bottom IS the floor the
      // cat just stepped off — which is how it ended up here.
      if (up && py <= w.y1 + 1) {
        py = w.y1 + 1;
        if (w.ceil) {
          // The strip under the header is a real surface, and this is the only
          // route to it once the cat has left the one it drops onto at start().
          // Hanging unconditionally meant a cat that walked off it early could
          // never stand up there again — the top ledge existed but was, in
          // practice, spawn-only furniture.
          var topL = ledgeBelow(px, w.y1 - 2, w.y1 + 6);
          if (topL && Math.random() < 0.4) {     // …or step up onto it
            land(topL);
            aim(px > mid() ? -1 : 1, 0);
            return;
          }
          wall = null; rot = 180; py = w.y1;     // the ceiling — hang from it
          aim(px > mid() ? -1 : 1, 0);           // head back towards the middle
          setState('hang');
          stateUntil = clock + rand(2, 6);
        } else {
          var l = ledgeBelow(px, w.y1 - 2, w.y1 + 6);
          if (l) { land(l); aim(px > mid() ? -1 : 1, 0); } else face = -face;
        }
        return;
      }
      if (!up && py >= w.y2 - 1) {
        py = w.y2 - 1;
        var l2 = ledgeBelow(px, py - 4, py + 10);
        // Step off towards open space, or it just paces against the wall.
        if (l2) { land(l2); aim(px > mid() ? -1 : 1, 0); } else face = -face;
        return;
      }
      // Cats also just let go sometimes — but rarely, and this is why. A climb has
      // to survive several of these rolls to cross a real window's height, so at
      // a 50/50 let-go the ceiling was unreachable in practice and the whole hang
      // state was dead code. Committed climber, occasional change of heart.
      if (clock >= stateUntil) {
        var r = Math.random();
        stateUntil = clock + rand(1.5, 4);
        if (r < 0.06) toFall((px < mid() ? 1 : -1) * 30, -40);
        else if (r < 0.12) face = -face;
      }
      return;
    }

    if (state === 'hang') {
      var fh = fwd();
      px += fh.x * face * CFG.HANGSPEED * dt;
      if (px < bounds.left + 6 || px > bounds.right - 6) {
        px = clamp(px, bounds.left + 6, bounds.right - 6);
        var wcl = wallNear(px, bounds.top + 4);
        if (wcl) toClimb(wcl, false); else face = -face;
        return;
      }
      if (clock >= stateUntil) {
        if (Math.random() < 0.55) toFall(rand(-30, 30), 0);
        else { face = -face; stateUntil = clock + rand(2, 5); }
      }
      return;
    }

    if (state === 'idle') {
      if (clock >= stateUntil) toWalk();
      return;
    }

    if (state === 'chase') {
      var want = clamp(mouse.x, ledge ? ledge.x1 + 4 : 4, ledge ? ledge.x2 - 4 : W - 4);
      var d = want - px;
      aim(d, 0);
      px += (d > 0 ? 1 : -1) * CFG.CHASE * dt;
      if (Math.abs(d) < 8 || clock >= stateUntil) {
        setState('idle', 'look');                // caught up to it, now play dumb
        stateUntil = clock + rand(1.2, 2.4);
      }
      return;
    }

    // walk
    if (!ledge) { toFall(0, 0); return; }
    var f2 = fwd();
    px += f2.x * face * CFG.WALK * dt;
    if (px <= ledge.x1 + 1 || px >= ledge.x2 - 1) { atEdge(px <= ledge.x1 + 1 ? -1 : 1); return; }
    if (clock >= nextHop) {
      nextHop = clock + rand(CFG.HOP_EVERY[0], CFG.HOP_EVERY[1]);
      if (Math.random() < CFG.HOP_CHANCE && tryHop(f2.x * face >= 0 ? 1 : -1)) return;
    }
    if (clock >= stateUntil) {
      // Occasionally it notices the cursor instead of settling down.
      var fresh = clock - mouse.t < 4 && mouse.x > ledge.x1 && mouse.x < ledge.x2 &&
        Math.abs(mouse.y - py) < 160 && Math.abs(mouse.x - px) > 40;
      if (fresh && Math.random() < 0.3) { setState('chase'); stateUntil = clock + 4; }
      else toIdle();
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  // One transform, rebuilt every frame. The trailing translate parks the sprite
  // so its foot line sits exactly on the anchor, whatever the rotation or facing.
  function draw() {
    cat.style.transform =
      'translate3d(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px,0)' +
      ' rotate(' + rot + 'deg)' +
      ' scaleX(' + face + ')' +
      ' translate(' + (-CFG.W / 2) + 'px,' + (-CFG.H) + 'px)';

    if (say) {
      var bw = say.offsetWidth || 200, bh = say.offsetHeight || 34;
      var bx = clamp(px + 20, bounds.left + 6, Math.max(bounds.left + 6, bounds.right - bw - 6));
      var by = clamp(py - bh - 20, bounds.top + 6, Math.max(bounds.top + 6, bounds.bottom - bh - 6));
      say.style.transform = 'translate3d(' + Math.round(bx) + 'px,' + Math.round(by) + 'px,0)';
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = (now - last) / 1000;
    last = now;

    // Freeze rather than stutter: a hidden tab, a modal, or a mobile-width shell
    // should all cost nothing and change nothing.
    if (document.hidden) return;
    if (vw() < CFG.MIN_VW) { root.style.display = 'none'; return; }
    // A TOAST is not a modal, and the trick panel in the shell is one: it takes
    // a corner rather than the screen, so freezing for it would mean pressing
    // 'jet' and watching a still robot next to the button that asked for it.
    // SweetAlert2 puts BOTH classes on the body for a toast, so "a modal is
    // open" has to be spelled out rather than assumed from swal2-shown.
    if (document.body.classList.contains('swal2-shown') &&
       !document.body.classList.contains('swal2-toast-shown')) return;
    root.style.display = '';

    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.05);

    if (now - lastScan > CFG.RESCAN_MS) {
      lastScan = now;
      scan();
      // Every state that believes it is standing on a specific ledge object.
      // 'boost' and 'cutout' are airborne like fall/hop and must NOT be here; they
      // hold a bare y, not a ledge, precisely because ledges go stale on rescan.
      if (state === 'walk' || state === 'idle' || state === 'chase' ||
        state === 'land' || state === 'crouch' || state === 'ignite') refoot();
    }

    update(dt);
    // 'leave' tears everything down from inside update(), so the cat may be gone.
    if (!running || !cat) return;
    draw();
  }

  // ── Drag ─────────────────────────────────────────────────────────────────────
  function wireCat() {
    var lastDown = 0;

    cat.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      // preventDefault below kills the compatibility mouse events, dblclick
      // included, so the "send it away" gesture is timed here by hand.
      var now = performance.now();
      if (now - lastDown < 400) {
        lastDown = 0;
        cat.classList.remove('yc2-grabbed');
        toLeave(true);
        e.preventDefault();
        return;
      }
      lastDown = now;
      e.preventDefault();
      try { cat.setPointerCapture(e.pointerId); } catch (err) { }
      // Stash where it was standing: a click that never moves is a poke, not a
      // pick-up, and the cat should stay put for it — otherwise the second click
      // of a dismissal has to hit a cat that is already falling away.
      grab = {
        id: e.pointerId, x: e.clientX, y: e.clientY, t: now, t0: now,
        ox: e.clientX, oy: e.clientY,          // where the POINTER went down
        vx: 0, vy: 0, moved: false, px0: px, py0: py, ledge0: ledge
      };
      ledge = null; wall = null; rot = 0;
      setState('drag');
      cat.classList.add('yc2-grabbed');
    });

    cat.addEventListener('pointermove', function (e) {
      if (!grab || e.pointerId !== grab.id) return;
      var now = performance.now(), dt = Math.max(16, now - grab.t) / 1000;
      grab.vx = (e.clientX - grab.x) / dt;
      grab.vy = (e.clientY - grab.y) / dt;
      grab.x = e.clientX; grab.y = e.clientY; grab.t = now;
      // Measured from where the POINTER started, not from px0/py0 — those are the
      // CAT's feet, and you grab a cat by its body. Against the feet anchor the
      // vertical test was already ~14px out before the hand moved at all, so any
      // jitter marked a poke as a drag and the cat got thrown instead of looking
      // at you. Only a perfectly still click survived it.
      if (Math.abs(e.clientX - grab.ox) > 4 || Math.abs(e.clientY - grab.oy) > 6) grab.moved = true;
      px = e.clientX;
      py = e.clientY + CFG.H * 0.45;      // dangles just below the cursor
      aim(grab.vx, 0);
      draw();
    });

    function release(e) {
      if (!grab || (e && e.pointerId !== grab.id)) return;
      var g = grab; grab = null;
      cat.classList.remove('yc2-grabbed');
      // A poke: put it back where it was and let it notice you.
      if (!g.moved && performance.now() - g.t0 < 350) {
        px = g.px0; py = g.py0; rot = 0;
        ledge = g.ledge0;
        if (ledge) { setState('idle', 'look'); stateUntil = clock + rand(1.2, 2.5); }
        else toFall(0, 0);
        talk();                 // after the pose, so the bubble is placed against it
        return;
      }
      toFall(clamp(g.vx * 0.35, -520, 520), clamp(g.vy * 0.35, -520, 520));
    }
    cat.addEventListener('pointerup', release);
    cat.addEventListener('pointercancel', release);
  }

  // ── Build / teardown ─────────────────────────────────────────────────────────
  // ── The bubble ───────────────────────────────────────────────────────────────
  // ONE bubble, for everything the robot says when poked — and for anything
  // else that ever wants to say something. Holding the timer is the whole
  // reason this is not two functions: a line that replaces another has to take
  // the clock with it, or the first line's expiry cuts the second one short a
  // moment after it appears.
  function speak(text, secs) {
    if (!root) return;
    if (!say) {
      say = document.createElement('div');
      say.className = 'yc2-say';
      root.appendChild(say);
      requestAnimationFrame(function () { if (say) say.classList.add('show'); });
    }
    say.textContent = text;
    clearTimeout(sayTimer);
    sayTimer = setTimeout(hideSay, secs * 1000);
    draw();                    // place it now, or it fades in from the corner
  }

  // Never the same line twice running: a pet that repeats itself reads as a
  // three-item list, however long the list actually is.
  function talk() {
    var i = Math.floor(Math.random() * LINES.length);
    if (i === lastLine && LINES.length > 1) i = (i + 1) % LINES.length;
    lastLine = i;
    // Long lines get longer on screen, within reason.
    speak(LINES[i], Math.min(7, 2.6 + LINES[i].length * 0.045));
  }

  function hideSay() {
    if (!say) return;
    clearTimeout(sayTimer);
    sayTimer = 0;
    var s = say;
    say = null;
    s.classList.remove('show');
    setTimeout(function () { s.remove(); }, 500);
  }

  function build() {
    styleEl = document.createElement('style');
    styleEl.id = 'yc2-mascot-style';
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);

    root = document.createElement('div');
    root.id = 'yc2-mascot';

    cat = document.createElement('div');
    cat.className = 'yc2-cat';
    cat.innerHTML = SVG;
    cat.title = NAME + ' · drag me · double-click to send me away';
    root.appendChild(cat);
    document.body.appendChild(root);

    wireCat();
  }

  function start() {
    if (running) return;
    if (!document.body) return;
    if (vw() < CFG.MIN_VW) return;
    running = true;
    if (!root) build();
    scan();
    lastScan = performance.now();
    clock = 0;
    jet = null;
    jetReady = CFG.JET_FIRST;      // it has to be here a while before it gets ideas
    px = bounds.left + (bounds.right - bounds.left) * rand(0.35, 0.65);
    py = bounds.top - 40;
    toFall(rand(-20, 20), 0);            // drops in from off the top
    draw();
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (root) { root.remove(); root = null; cat = null; }
    if (styleEl) { styleEl.remove(); styleEl = null; }
    grab = null;
  }

  // ── The trigger: long-press the header logo ──────────────────────────────────
  function wireTrigger() {
    var logo = document.querySelector('.hdr-logo');
    if (!logo) return;
    var timer = null, fired = false;

    function charge() { logo.classList.add('yc2-charging'); }
    function discharge() { logo.classList.remove('yc2-charging'); }

    logo.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      fired = false;
      charge();
      timer = setTimeout(function () {
        timer = null;
        fired = true;                    // so the <a> around the logo stays put
        discharge();
        toggle();
      }, CFG.HOLD_MS);
    });

    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
      discharge();
      // The click that follows a long press has to be swallowed, but only that
      // one — leave the flag up long enough to catch it and no longer.
      if (fired) setTimeout(function () { fired = false; }, 400);
    }
    logo.addEventListener('pointerup', cancel);
    logo.addEventListener('pointerleave', cancel);
    logo.addEventListener('pointercancel', cancel);
    logo.addEventListener('dragstart', function (e) { e.preventDefault(); });
    logo.addEventListener('contextmenu', function (e) { if (fired) e.preventDefault(); });

    // Capture phase, so the anchor never gets the chance to navigate.
    document.addEventListener('click', function (e) {
      if (!fired) return;
      if (e.target === logo || (e.target.nodeType === 1 && e.target.contains && e.target.contains(logo))) {
        e.preventDefault();
        e.stopPropagation();
        fired = false;
      }
    }, true);
  }

  function toggle() {
    if (running) toLeave(true);
    else { store.set(true); start(); }
  }

  // ── Console control ──────────────────────────────────────────────────────────
  // Nothing in the file calls any of this; it exists so the cat can be made to do
  // a thing on demand instead of waiting for it to feel like it — which for the
  // jetpack is otherwise a four-minute wait per attempt.
  //
  // `run` returns nothing when the action took, or a STRING saying why it did
  // not. A console command that silently does nothing is worse than one that
  // says "no wall in reach" — you cannot tell a refusal from a broken build.
  var ACTIONS = [
    { name: 'walk', needs: 'ledge', what: 'set off along the ledge it is on', run: function () { toWalk(); } },
    { name: 'idle', needs: 'ledge', what: 'stop, and roll one of the idle acts', run: function () { toIdle(); } },
    { name: 'talk', needs: 'any', what: 'say one of its lines — the same thing a poke does', run: function () { talk(); } },
    {
      name: 'jump', needs: 'ledge', what: 'drop to a lower ledge — or hop on the spot if there is none',
      run: function () {
        var d = fwd().x * face >= 0 ? 1 : -1;
        if (tryHop(d) || tryHop(-d)) return;
        // Nothing below worth dropping to. Do the hop anyway rather than refuse:
        // it is the same crouch and the same arc, it just lands where it started.
        hop = { vx: 0, vy: -CFG.HOP_LIFT * 1.15, floor: py + 10 };
        setState('crouch');
        stateUntil = clock + CFG.HOP_CROUCH;
      }
    },
    {
      name: 'jet', needs: 'ledge', what: 'the jetpack. Ignores the cooldown, and burns to the ceiling if nothing is overhead',
      run: function () { if (!tryJet(true)) return 'no room above it to rise'; }
    },
    {
      name: 'climb', needs: 'any', what: 'take the nearest wall and go up it',
      run: function () {
        var best = null, gap = 1e9;
        for (var i = 0; i < walls.length; i++) {
          var g = Math.abs(walls[i].x - px);
          // Inclusive at both ends: a wall's y2 IS the floor, so an exclusive
          // test refuses every cat standing on the ground — which is most of them.
          if (g < gap && py >= walls[i].y1 - 2 && py <= walls[i].y2 + 2) { gap = g; best = walls[i]; }
        }
        if (!best) return 'no wall in reach';
        toClimb(best, true);        // note: toClimb snaps px to the wall, so this teleports
      }
    },
    {
      name: 'hang', needs: 'any', what: 'hang from the ceiling (cheats — it does not walk there)',
      run: function () {
        ledge = null; wall = null; jet = null;
        rot = 180; py = bounds.top;
        px = clamp(px, bounds.left + 8, bounds.right - 8);
        aim(px > mid() ? -1 : 1, 0);
        setState('hang');
        stateUntil = clock + rand(3, 7);
      }
    },
    {
      name: 'fall', needs: 'any', what: 'let go and drop from wherever it is',
      run: function () {
        // The nudge is load-bearing. ledgeBelow() searches (y0 .. py] inclusive
        // of y0, so a cat that lets go while standing ON a ledge finds that same
        // ledge on its first airborne frame and lands straight back on it. The
        // walking path never hits this because atEdge() steps off the end first.
        py += 2;
        toFall(rand(-40, 40), 30);
      }
    },
    {
      name: 'chase', needs: 'ledge', what: 'run at the cursor',
      run: function () {
        if (mouse.x < 0) return 'move the mouse first — it has not seen the cursor yet';
        setState('chase');
        stateUntil = clock + 4;
      }
    },
    { name: 'flip', needs: 'any', what: 'turn around', run: function () { face = -face; } }
  ];

  // The idle repertoire gets one command each, read straight off IDLE_ACTS so
  // the two lists cannot drift apart when someone adds a seventh thing to do.
  (function () {
    for (var i = 0; i < IDLE_ACTS.length; i++) {
      (function (a) {
        ACTIONS.push({
          name: a, needs: 'ledge', what: 'idle: ' + a,
          run: function () {
            setState('idle', a);
            if (a === 'standby') face = 1;      // …or the z's come out mirrored
            stateUntil = clock + (a === 'standby' ? rand(6, 12) : rand(3, 6));
          }
        });
      })(IDLE_ACTS[i][0]);
    }
  })();

  function findAction(n) {
    n = String(n == null ? '' : n).toLowerCase();
    for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i].name === n) return ACTIONS[i];
    return null;
  }

  function doAction(name) {
    if (!running || !cat) {
      console.warn('[Mascot2] not out — Mascot2.on()');
      return false;
    }
    if (name == null) name = ACTIONS[Math.floor(Math.random() * ACTIONS.length)].name;
    var a = findAction(name);
    if (!a) { console.warn('[Mascot2] no action "' + name + '" — try Mascot2.list()'); return false; }
    // 'drag' and every airborne state have no ledge, so this one test covers all
    // the ways the cat can be in no position to oblige.
    if (a.needs === 'ledge' && !ledge) {
      console.warn('[Mascot2] ' + a.name + ' needs it standing on something (state: ' + state + ')');
      return false;
    }
    var why = a.run();
    if (typeof why === 'string') { console.warn('[Mascot2] ' + a.name + ': ' + why); return false; }
    draw();          // so the new pose shows at once, even mid-freeze
    return a.name;
  }

  window.Mascot2 = {
    on: function () { store.set(true); start(); },
    off: function () { store.set(false); stop(); },
    toggle: toggle,
    // Is it out right now? For a caller that wants to know whether a toggle()
    // took — start() declines on a narrow window, and a button that gives no
    // sign either way reads as broken. Not the stored preference: that can say
    // '1' while nothing is on screen.
    out: function () { return running; },
    'do': doAction,
    // list(true) is the same list with nothing printed: a caller building a UI
    // out of the names wants the array, not a console table every time a panel
    // opens.
    list: function (quiet) {
      var rows = [], names = [];
      for (var i = 0; i < ACTIONS.length; i++) {
        rows.push({ call: 'Mascot2.' + ACTIONS[i].name + '()', needs: ACTIONS[i].needs, what: ACTIONS[i].what });
        names.push(ACTIONS[i].name);
      }
      if (quiet) return names;
      try { console.table(rows); } catch (e) { console.log(rows); }
      console.log('Mascot2.do("name") runs one by name · Mascot2.do() rolls a random one');
      return names;
    },
    // Console aid for "why is it standing THERE": outlines the content box the
    // cat believes it lives in for three seconds, and returns the numbers.
    debug: function () {
      scan();
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;pointer-events:none;z-index:' + (CFG.Z + 1) +
        ';border:2px dashed var(--accent);background:color-mix(in srgb,var(--accent) 6%,transparent);' +
        'left:' + bounds.left + 'px;top:' + bounds.top + 'px;' +
        'width:' + (bounds.right - bounds.left) + 'px;height:' + (bounds.bottom - bounds.top) + 'px';
      document.body.appendChild(d);
      setTimeout(function () { d.remove(); }, 3000);
      var f = contentFrame();
      var r = function (el) {
        if (!el) return null;
        var b = el.getBoundingClientRect();
        return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)].join(',');
      };
      return {
        bounds: bounds,
        cat: { state: state, x: Math.round(px), y: Math.round(py), rot: rot },
        // Seconds until a burn is possible again. 0 means the only thing left
        // between you and one is the roll in toIdle() and something to fly to.
        burnIn: Math.max(0, Math.round(jetReady - clock)),
        // Where it is actually PAINTED. If painted.left is not ~cat.x while
        // climbing the left wall, the container is not resolving against the
        // viewport and some ancestor is creating a containing block.
        painted: r(cat), container: r(root),
        offsetParent: root && root.offsetParent ? root.offsetParent.tagName : null,
        ledges: ledges.length,
        perches: ledges.filter(function (l) { return l.perch; }).length,
        wallXs: walls.map(function (w) { return Math.round(w.x); }),
        frame: r(f), frameSrc: f && (f.getAttribute('src') || f.dataset.src),
        header: r(document.getElementById('appHeader')),
        sidebar: r(document.getElementById('appSidebar')),
        viewport: vw() + 'x' + vh(), dpr: window.devicePixelRatio
      };
    }
  };

  // One shorthand per action — Mascot2.jet(), Mascot2.standby(), Mascot2.jump()…
  // Guarded so an action can never quietly overwrite on/off/toggle/list/debug if
  // someone adds one called 'toggle' later.
  (function () {
    for (var i = 0; i < ACTIONS.length; i++) {
      (function (n) {
        if (window.Mascot2[n]) return;
        window.Mascot2[n] = function () { return doAction(n); };
      })(ACTIONS[i].name);
    }
  })();

  // SOLO: is this file the only mascot on the page? Decided at boot, because
  // mascot.js is deferred too and may not have run when this one is evaluated.
  //
  // Loaded ALONGSIDE the shipping cat (the console one-liner in the banner) it
  // takes nothing that is already spoken for: no `window.Mascot`, no logo
  // long-press — that gesture belongs to whoever answers on the shell, and two
  // pets fighting over one press is the one way this can annoy somebody who did
  // not ask to test anything — and no auto-start. Mascot2.on() is the way in.
  //
  // Loaded INSTEAD of it (the <script> tag swapped over) the name is free, so it
  // takes it, and the Cat tile and its trick panel drive the robot untouched.
  var SOLO = false;

  function boot() {
    SOLO = !window.Mascot;
    if (SOLO) {
      window.Mascot = window.Mascot2;
      wireTrigger();
      if (store.get()) start();                    // asked for it, last time
    }
    // Wired once, at boot rather than per build(), so on/off cycles don't stack
    // up duplicate listeners. It only feeds the occasional cursor chase.
    document.addEventListener('pointermove', function (e) {
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.t = clock;
    }, { passive: true });
    window.addEventListener('resize', function () { lastScan = -1e9; });

    // The one thing this file does that mascot.js does not: say it is here. It
    // is a sandbox loaded by hand from a console, and a script that pastes in
    // and then sits silently is indistinguishable from one that threw.
    console.info('[Mascot2] ' + NAME + ' loaded' + (SOLO ? '' : ' (alongside mascot.js)') +
      ' — Mascot2.on() · Mascot2.list()');
  }
  // NOTE: boot() is called at the very BOTTOM of this file, not here. This script
  // is deferred, so readyState is already "interactive" and boot() would run
  // synchronously — before the SVG and CSS below have been assigned. That put the
  // string "undefined" in the cat and in the stylesheet, but only for someone who
  // already had the pref set, because a long-press happens long after evaluation.

  // ── The sprite ───────────────────────────────────────────────────────────────
  // 36×28, side view, facing right, feet on the bottom edge of the box — the same
  // box mascot.js uses, and the same pivots (hips at y 18.5, neck at 25,12, tail
  // root at 6,15), so every pose the physics asks for still means what it meant
  // there. Parts are grouped so the CSS below can pose them per state.
  //
  // THE WIN95 BEVEL is the whole look and it is why there is not a gradient in
  // here: every plate is a flat face, a white line along its top, a grey line
  // along its bottom, and a near-black outline. Four greys and one LED:
  //   #C6CAD0 face · #F4F7FA highlight · #8B929B shade · #5A616B dark
  //   #2F343B outline · #4FE3C1 LED · #FF6B4A warning · #FFC94A/#FF7A32 flame
  // Those fills stay literal for the reason mascot.js's did: this is ARTWORK, not
  // chrome. A steel robot has to read as a steel robot in both themes, and there
  // is no token for "robot". Dark mode lifts the whole sprite with a filter on
  // .yc2-cat instead. The two pieces that ARE app UI — the speech bubble and the
  // standby dots — take app tokens below.
  var SVG =
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
    // The exhaust points DOWN, which is the whole reason CFG.JET_HEAD is just the
    // sprite's own height: nothing about this rig sticks up over the robot.
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
    // STANDBY — a charging bolt and two status dots, where mascot.js had its z's.
    '<g class="r-zzz">' +
    '<path class="r-bolt" d="M32.6 -3.4 L30.2 1.2 H31.9 L31.1 4.6 L33.9 -.2 H32.1 Z"' +
    ' fill="#FFC94A" stroke="#2F343B" stroke-width=".4" stroke-linejoin="round"/>' +
    '<circle class="r-d1" cx="35.2" cy="-1.2" r=".9"/>' +
    '<circle class="r-d2" cx="36.6" cy="-4.6" r=".9"/>' +
    '</g></svg>';

  // ── Styles ───────────────────────────────────────────────────────────────────
  // The theme note in one line: mascot.js eases its poses, and this file STEPS
  // them. Every transition and most of the animations here run on steps(), so
  // limbs snap between positions the way a servo does instead of arriving softly.
  // It is the single cheapest thing that makes the same skeleton read as a
  // machine, and it is why the timings below are mostly mascot.js's numbers.
  var CSS = [
    '#yc2-mascot{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:' + CFG.Z + ';}',
    '@media print{#yc2-mascot{display:none!important}}',
    '.yc2-cat{position:absolute;left:0;top:0;width:' + CFG.W + 'px;height:' + CFG.H + 'px;',
    // LOAD-BEARING. draw() composes rotate/scaleX about the element's origin;
    // the CSS default of 50% 50% pivots about the sprite's centre instead and
    // throws it 32px off its anchor — invisibly at rot:0, but every climb and
    // hang lands beside the wall rather than on it.
    'transform-origin:0 0;',
    'pointer-events:auto;cursor:grab;touch-action:none;will-change:transform;',
    'filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.30));}',
    '.yc2-cat.yc2-grabbed{cursor:grabbing}',
    // The bubble is a small panel of app UI, so it takes app tokens. Squarer than
    // mascot.js's — 4px, not 13 — because what it is quoting is a system dialog.
    '.yc2-say{position:absolute;left:0;top:0;max-width:250px;padding:8px 12px;border-radius:4px;',
    'background:var(--surface);color:var(--text);border:1px solid var(--border);box-shadow:0 4px 14px rgba(0,0,0,.16);',
    'font:500 12.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;',
    'pointer-events:none;opacity:0;transition:opacity .45s ease;will-change:transform}',
    '.yc2-say.show{opacity:1}',
    'html[data-theme="dark"] .yc2-cat{filter:drop-shadow(0 1px 2px rgba(0,0,0,.55)) brightness(1.12)}',
    '.yc2-cat svg{display:block;overflow:visible}',
    '.yc2-cat g,.yc2-cat path,.yc2-cat rect,.yc2-cat circle{transform-box:view-box}',

    /* pivots: mascot.js's exactly — legs from the hip, head from the neck, tail
       from the rump — plus the two this file adds, both at the nozzle mouth */
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

    /* ── the jetpack ─────────────────────────────────────────────────────────
       Shown ONLY by these three state selectors, and hidden by default. That is
       load-bearing, not tidiness, and it is inherited straight from the balloon
       it replaced: it means toLeave(), a drag, the ground going away mid-spool
       and every other way out of a burn all put the pack away for free, without
       a single one of them having to know it exists. */
    '.r-jet{opacity:0}',
    '[data-state="ignite"] .r-jet,[data-state="boost"] .r-jet,[data-state="cutout"] .r-jet{opacity:1}',
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
    /* the hover pivots about the NOZZLE, not the feet: the thing holding it up is
       down there, so a wobble in the thrust swings the head furthest. */
    '@keyframes ycr-hover{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}',
    '[data-state="ignite"] .r-flame{opacity:1;animation:ycr-spool ' + CFG.SPOOL_MS + 's steps(9,end) both}',
    '[data-state="ignite"] .r-spark{animation:ycr-sparks ' + CFG.SPOOL_MS + 's steps(6,end) both}',
    '[data-state="ignite"] .r-all{transform:translateY(2px) scaleY(.94) scaleX(1.05)}',
    '[data-state="ignite"] .r-head{transform:rotate(8deg)}',      /* braced for it */
    '[data-state="ignite"] .r-tail{transform:rotate(-24deg)}',
    '[data-state="boost"] .r-flame{opacity:1;animation:ycr-burn .11s steps(2,end) infinite}',
    '[data-state="boost"] .r-jet{animation:ycr-shudder .07s steps(2,end) infinite}',
    '[data-state="boost"] .r-all{transform-origin:2.2px 23.6px;animation:ycr-hover 1.8s ease-in-out infinite}',
    /* NOT a dangle on all four: four legs swinging in antiphase is a gait, and a
       flying robot that appears to be walking is the whole illusion gone. The
       front pair holds the splay the fall pose uses — which already reads as
       airborne — and only the back pair swings. */
    '[data-state="boost"] .r-fl,[data-state="boost"] .r-fr{transform:rotate(-16deg)}',
    '[data-state="boost"] .r-bl,[data-state="boost"] .r-br{animation:ycr-dangle 1.7s ease-in-out infinite}',
    '[data-state="boost"] .r-br{animation-delay:.85s}',
    '[data-state="boost"] .r-tail{transform:rotate(20deg)}',
    '[data-state="boost"] .r-head{transform:rotate(-8deg)}',
    '[data-state="cutout"] .r-flame{opacity:1;animation:ycr-die ' + CFG.CUT_MS + 's ease-out forwards}',
    '[data-state="cutout"] .r-smoke{opacity:1;animation:ycr-puff ' + (CFG.CUT_MS * 2.2).toFixed(2) + 's ease-out forwards}',
    '[data-state="cutout"] .r-head{transform:rotate(-15deg)}',    /* flamed out */
    '[data-state="cutout"] .r-eye{fill:#FF6B4A}',
    '[data-state="cutout"] .r-fl,[data-state="cutout"] .r-fr{transform:rotate(-38deg)}',
    '[data-state="cutout"] .r-bl,[data-state="cutout"] .r-br{transform:rotate(34deg)}',
    '[data-state="cutout"] .r-all{transform:scaleY(.94) scaleX(1.07)}',

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
       the same two-part gesture mascot.js grooms with, on a can of oil */
    '@keyframes ycr-oilH{0%,100%{transform:rotate(0)}40%,70%{transform:rotate(25deg) translateY(1px)}}',
    '@keyframes ycr-oilP{0%,100%{transform:rotate(0)}40%{transform:rotate(-62deg)}55%{transform:rotate(-48deg)}70%{transform:rotate(-62deg)}}',
    '[data-act="oil"] .r-head{animation:ycr-oilH 1.8s ease-in-out infinite}',
    '[data-act="oil"] .r-fr{animation:ycr-oilP 1.8s ease-in-out infinite}',
    '[data-act="oil"] .r-all{transform:translateY(2px)}',
    /* stretch: the pistons telescope out and back, in four visible stops */
    '@keyframes ycr-stretch{0%,100%{transform:none}45%{transform:scaleX(1.16) scaleY(.86) translateY(2px)}}',
    '[data-act="stretch"] .r-all{animation:ycr-stretch 2.2s steps(7,end) infinite}',
    '[data-act="stretch"] .r-tail{transform:rotate(-34deg)}',
    /* glitch — mascot.js scratches an ear here. This one disagrees with itself
       for a few seconds: the chassis jitters a pixel and the visor argues about
       what colour an alarm is. */
    '@keyframes ycr-glitch{0%{transform:translate(-.7px,0)}25%{transform:translate(.7px,-.5px)}',
    '50%{transform:translate(-.5px,.5px)}75%{transform:translate(.6px,.2px)}100%{transform:translate(-.7px,0)}}',
    '@keyframes ycr-err{0%,100%{fill:#FF6B4A}50%{fill:#4FE3C1}}',
    '[data-act="glitch"] .r-all{animation:ycr-glitch .09s steps(1,end) infinite}',
    '[data-act="glitch"] .r-eye{animation:ycr-err .16s steps(1,end) infinite}',
    '[data-act="glitch"] .r-head{transform:rotate(-6deg)}',

    /* standby — the visor shutters, everything folds, the charger comes on. It
       always faces right (see toIdle), so the bolt is never mirrored. */
    '[data-act="standby"] .r-all{transform:translateY(4px) scaleY(.84) scaleX(1.05)}',
    '[data-act="standby"] .r-leg{transform:rotate(72deg)}',
    '[data-act="standby"] .r-lid{opacity:1}',
    '[data-act="standby"] .r-eye{opacity:0;animation:none}',
    '[data-act="standby"] .r-antball{animation-duration:2.6s}',
    '[data-act="standby"] .r-tail{transform:rotate(24deg)}',
    '.r-zzz{opacity:0}',
    // The dots are muted text over the page, so they take the app token, exactly
    // as mascot.js's z's do. The bolt does not: it is a light on the robot.
    '.r-zzz circle{fill:var(--text-muted);transform-box:fill-box;transform-origin:50% 50%}',
    '@keyframes ycr-z{0%{opacity:0;transform:translate(0,0) scale(.7)}25%{opacity:.9}100%{opacity:0;transform:translate(4px,-9px) scale(1.1)}}',
    '@keyframes ycr-charge{0%,100%{opacity:.22}50%{opacity:1}}',
    '[data-act="standby"] .r-zzz{opacity:1}',
    '[data-act="standby"] .r-bolt{animation:ycr-charge 1.9s steps(3,end) infinite}',
    '[data-act="standby"] .r-d1{animation:ycr-z 2.6s ease-out infinite}',
    '[data-act="standby"] .r-d2{animation:ycr-z 2.6s ease-out infinite 1.3s}',

    /* the trigger: the logo visibly charges while you hold it */
    '.hdr-logo.yc2-charging{transform:scale(.86);opacity:.6;',
    'transition:transform ' + CFG.HOLD_MS + 'ms ease-in,opacity ' + CFG.HOLD_MS + 'ms ease-in;}'
  ].join('\n');

  // Last line on purpose — everything the robot is made of has to exist first.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
