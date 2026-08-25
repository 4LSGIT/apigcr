/* public/js/mascot.js
 * ───────────────────────────────────────────────────────────────────────────────
 * THE CAT (an easter egg)
 *
 * A Win95-style desktop pet for the YisraCase shell. It wanders, sits, grooms,
 * sleeps, climbs the walls, hangs off the ceiling, falls off ledges, and — the
 * whole reason it is worth doing here — walks along the tops of the real tables,
 * cards and buttons inside whatever page is open, dropping down onto a lower one
 * when it sees a landing it likes, because every content page in this shell is a
 * SAME-ORIGIN iframe and `contentDocument` is readable.
 *
 * Once in a long while it also blows up a balloon and floats UP to something
 * overhead, where the balloon bursts against the ledge and drops it onto it.
 * That one is rare on purpose — see the FLY_* block in CFG.
 *
 * Self-contained by design: this file is the entire feature. It has no
 * dependencies (no Font Awesome, no SweetAlert, no images, no network), injects
 * its own <style> and its own inline SVG, and touches exactly one line of
 * index.html — the <script> tag that loads it. Delete the file and the tag and
 * nothing else in the codebase knows it existed.
 *
 * HOW YOU GET IT
 *   Long-press the header logo for ~0.9s. Same gesture puts it away. So does
 *   double-clicking the cat, or Mascot.off() from the console. The choice is
 *   remembered per browser in localStorage. OFF by default for everyone — a
 *   colleague who never finds the gesture never sees a cat.
 *
 * DRIVING IT FROM THE CONSOLE
 *   Mascot.list()   — every action it can be told to do, and what each needs
 *   Mascot.fly()    — …or .jump() .climb() .sleep() .hang() etc, one per action
 *   Mascot.do(name) — the same thing by name; Mascot.do() rolls a random one
 *   Mascot.debug()  — outlines the box the cat thinks it lives in
 *   Nothing else in the file calls these: they exist so the thing can be poked
 *   at without waiting twenty minutes for it to feel like doing the trick.
 *
 * WHY IT CANNOT BITE YOU
 *   - z-index 900: above shell chrome (≤100), below the versionGuard bar (999)
 *     and below SweetAlert2 (1060), so a modal always covers it. It also freezes
 *     while a Swal is open.
 *   - The container is pointer-events:none; only the 36×28 cat itself takes
 *     pointer events, so it can never swallow a click meant for the app.
 *   - Paused when the tab is hidden, and while the viewport is too narrow.
 *   - Respects prefers-reduced-motion by not existing at all.
 *   - No network calls, no analytics, nothing written but one localStorage key.
 *   - Loaded only by the staff shell. The portal, booking, e-sign and form pages
 *     never see this file, so nothing client-facing can ever show a cat.
 */
(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────
  // Every tunable lives here. The speeds are deliberately slow: a pet that
  // hurries reads as a bug, a pet that ambles reads as a pet.
  var CFG = {
    W: 36, H: 28,          // sprite box, px
    GRAVITY: 1500,         // px/s²
    TERMINAL: 900,         // px/s
    WALK: 46,              // px/s
    CLIMB: 55,             // cats go up faster than they saunter

    HANGSPEED: 30,
    CHASE: 92,
    HOLD_MS: 900,          // long-press duration on the logo
    Z: 900,
    MIN_VW: 900,           // below this the shell is in mobile layout — no cat
    RESCAN_MS: 1200,       // platform rescan throttle
    MAX_PLATFORMS: 40,
    KEY: 'yc.mascot.on',   // matches the yc.* convention in scripts.js

    // PERCHES — buttons, tabs, pills. Far smaller than the furniture above, so
    // they need their own size floor (a button is ~30px tall, and the furniture
    // floor of 24px height / 120px width excludes every one of them) and their
    // own slice of the platform budget: the list is sorted by area, so on a page
    // full of cards a shared budget would crowd out every button on it.
    PERCH_W: 44, PERCH_H: 16, PERCH_SPAN: 40,
    MAX_PERCHES: 18,

    // How hard scan() is allowed to look. The old limit was 250 elements in
    // DOCUMENT order, which on a long page scrolled halfway down spends the
    // whole budget on rows that are off the top of the frame and finds the cat
    // nothing to stand on. Buttons made that much likelier — there are ten of
    // them for every card — so the budget now counts what it FINDS, walking
    // further down the document until it has enough that is actually on screen.
    SCAN_ELS: 1400,        // hard stop on rects measured, per selector
    SCAN_KEEP: 60,         // …or stop early once this many are in view

    // DROPPING DOWN. A cat on a ledge with something a short way below it will
    // sometimes just take the drop rather than walk to the end. Looks every
    // HOP_EVERY seconds while walking and takes it HOP_CHANCE of the time, so
    // it stays an occasional flourish and not a permanent pinball.
    HOP_CHANCE: 0.22,
    HOP_EVERY: [0.7, 1.7], // s between looks
    HOP_DROP_MIN: 20,      // below this it is a step, not a drop
    HOP_DROP_MAX: 200,
    HOP_LEAD: 26,          // aim this far ahead of the feet
    HOP_LIFT: 130,         // px/s of push-off, so it arcs instead of sliding off
    HOP_VX_MAX: 210,       // further sideways than this is not a drop, it's a leap
    HOP_CROUCH: 0.14,      // s of wind-up before the push

    // THE BALLOON. The only thing in here a cat cannot actually do, which is
    // exactly why it has to stay rare: seen twice it is a delight, seen every
    // minute it is a physics engine with a bug in it. The rarity is carried by
    // the COOLDOWN, not the roll — the roll only stops it being clockwork — and
    // it is decided when the cat settles down, so it reads as a cat with an idea
    // rather than a cat interrupted mid-stride.
    //
    // It rises CLEAR of a real ledge overhead — feet POP_CLEAR above the surface,
    // not below it — and bursts there. Getting that the wrong way round is the
    // one mistake this whole thing can make: burst under the ledge and the cat
    // drops away from the very thing it spent six seconds floating up to. Pop
    // above it and the ordinary fall code lands it on top, exactly the way a drop
    // does. No new landing path, no new special case.
    FLY_CHANCE: 0.15,      // per settle-down, once the cooldown is up
    FLY_COOLDOWN: 240,     // s from one balloon to the next being possible
    FLY_FIRST: 45,         // …and none at all in the first seconds after it arrives
    FLY_GAP_MIN: 90,       // less overhead than this and it may as well have hopped
    // How FAR up it will go is really a question of how LONG the float lasts, so
    // that is the number kept here and the reach falls out of it. A flat pixel
    // cap was the second reason the top ledge was unreachable: from the floor of
    // a 900px window the header strip is ~844px up, and any cap tight enough to
    // feel safe cut it off. Crossing the whole page is the trick, not a bug.
    FLY_MAX_SECS: 11,      // longest a float may last, at FLY_MAX_VY
    POP_CLEAR: 46,         // px above the target the feet reach before it bursts
    FLY_HEAD: 52,          // px from the feet to the top of the balloon — see the SVG

    // …except over the TOPMOST ledge, the strip under the header, where there is
    // not 46px of anything to rise into. The balloon's crown is FLY_HEAD above
    // the feet, so landing up there means the balloon spends its last second in
    // the header — which is allowed and always was: the cat is painted at z-index
    // 900, above shell chrome. The real ceiling is the WINDOW, not the content
    // box, and measuring against the content box was what made the top ledge
    // unreachable: every candidate failed a test it could never pass.
    //
    // So the clearance is whatever is left before the crown reaches y 0, and the
    // balloon bursting against the top of the window is the nicer beat anyway.
    //
    // POP_MIN is 0 because the number it used to hold was a trap. The only ledge
    // that can ever score under 3 is this one: everything collectTops() returns
    // is floored at `view.top + 8`, so every ledge in the open page clears 8 or
    // more, and the floor clears the full POP_CLEAR. A non-zero POP_MIN gated
    // exactly one ledge, and gated it on the header height — at --header-h 56px
    // the top ledge scored 4 and passed, at 52 it scores 0 and quietly stopped
    // being a target, which is the failure this comment used to predict. Zero
    // keeps the test that still matters: a clearance below zero means the crown
    // would be pushed out of the top of the window, and that is still rejected.
    POP_MIN: 0,            // least clearance still worth calling a landing
    FLY_LIFT: 150,         // px/s² the balloon pulls with, so it takes up the slack
    FLY_MAX_VY: 95,        // px/s ceiling on the rise. A balloon is not a rocket.
    FLY_SWAY: 9,           // px of side-to-side drift, about the launch column
    INFLATE_MS: 0.95,      // wind-up: the balloon filling
    POP_MS: 0.22,          // the burst, before it starts falling

    // THE DEBUT. Until this moment the cat comes out on its own for anyone who
    // has not made a choice about it, and introduces itself on every load. After
    // it, the cat only ever appears for someone who asked for it. Deliberately a
    // hard date and not a duration: an introduction that quietly never ends is
    // just a default, and turning it off again would cost a deploy.
    //
    // The introduction repeats EVERY page load until the person actually makes a
    // choice, because the bubble is the only place the gesture is explained. Show
    // it once per browser and anyone who missed it in those 14 seconds is left
    // with an unexplained animal and no way to get rid of it. Dismissing the cat
    // writes the pref, the pref ends the debut branch, and the bubble stops.
    //
    // Parsed as LOCAL time (no timezone suffix), so the window closes at the end
    // of that day in each person's own browser.
    //
    // ── RIPPING THE DEBUT OUT LATER ──────────────────────────────────────────
    // Nothing has to be done: once the date passes this is inert, and the cat is
    // opt-in only. To remove it for real:
    //   1. The kill switch is ONE edit — delete the `else if (pref === null &&
    //      inDebut())` branch in boot(). Nothing auto-starts after that.
    //   2. Then, at leisure, the rest is dead: CFG.DEBUT_UNTIL, DEBUT_ENDS/
    //      inDebut(), showSay()/hideSay() and the `if (say)` block in draw(),
    //      the `.yc-say` CSS, `say` and `autoDebut`, and the expiry check at the
    //      top of frame().
    //   3. KEEP toLeave() and leaveRecords — dismissal uses them, not just the
    //      debut. Keep the three-state store too; harmless, and '0' still means
    //      "this person said no" rather than "never asked".
    // Older builds left a `yc.mascot.met` key in some browsers. Nothing reads it
    // any more; it can be ignored.
    DEBUT_UNTIL: '2026-08-27T23:59:59'
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

  // Idle actions, with weights. This is where the personality lives.
  var IDLE_ACTS = [
    ['sit', 26], ['look', 20], ['groom', 18],
    ['sleep', 14], ['stretch', 12], ['scratch', 10]
  ];

  // ── Bail-outs, before anything is built ──────────────────────────────────────
  // Reduced motion is an accessibility request, not a preference: a creature
  // that wanders across the screen is exactly what it is asking us not to do.
  try {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) { /* no matchMedia — carry on */ }

  // localStorage throws outright under some privacy modes; if we cannot remember
  // the user's choice we should not be starting anything.
  // THREE states, not two. "Never decided" has to be distinguishable from "sent
  // it away", or the debut below would come back for precisely the people who
  // already made it clear they did not want a cat.
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

  // Debut window still open? A bad clock just means someone does or doesn't get
  // an introduction, which is not worth defending against.
  var DEBUT_ENDS = Date.parse(CFG.DEBUT_UNTIL);
  function inDebut() { return !isNaN(DEBUT_ENDS) && Date.now() < DEBUT_ENDS; }

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
  var fly = null;              // the balloon trip in progress: { popY, x0, t0 }
  var flyReady = 0;            // clock time the next balloon becomes possible
  var say = null;              // the introduction bubble, debut only
  var leaveRecords = true;     // does walking off count as "sent away"?
  var autoDebut = false;       // started by the debut rather than by a person

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
    // The balloon is decided HERE, at the moment the cat stops walking, because
    // a cat that has just settled is the one with time to have an idea. Rolling
    // it on a timer instead meant the timer usually elapsed mid-walk and the
    // chance was silently thrown away, which makes the real frequency a fiction.
    if (clock >= flyReady && Math.random() < CFG.FLY_CHANCE && tryFly(false)) return;
    setState('idle', pick(IDLE_ACTS));
    // A sleeping cat always faces right, so the floating z's are never mirrored.
    if (act === 'sleep') face = 1;
    stateUntil = clock + (act === 'sleep' ? rand(4, 9) : rand(1.8, 4.5));
  }

  function toFall(ivx, ivy) {
    ledge = null; wall = null;
    vx = ivx || 0; vy = ivy || 0;
    rot = 0;
    hopFloor = -1e9;
    fly = null;
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

  // Is there anything overhead worth a balloon? The mirror of tryHop, except the
  // cat has to end up OVER the target rather than beside it, which sets all three
  // of these tests:
  //   · the rise is a straight column, so the ledge must still be under the cat
  //     after the sway — hence the pad on each end;
  //   · it bursts at POP_CLEAR ABOVE the surface, so the fall that follows lands
  //     on top of it. Popping below would drop the cat back the way it came;
  //   · and it needs headroom for that: a ledge so near the top of the page that
  //     clearing it would push the balloon out of the content box is no good.
  //
  // `force` is the console's Mascot.fly(): a person who asked for a balloon gets
  // one even with nothing above, and it carries the cat to the top of the page
  // and bursts there. The ambient roll never does that — an idle cat that floats
  // to the top and falls all the way back down has done a trick with no payoff
  // at the end of it.
  function tryFly(force) {
    var pad = CFG.FLY_SWAY + 10;      // sway, plus room for the drift off the pop
    var roof = CFG.FLY_HEAD;          // feet here ⇒ the crown is at the top of the window
    var maxGap = CFG.FLY_MAX_VY * CFG.FLY_MAX_SECS;
    var cands = [];
    for (var i = 0; i < ledges.length; i++) {
      var l = ledges[i];
      if (l.x2 - l.x1 < CFG.PERCH_SPAN) continue;
      if (px < l.x1 + pad || px > l.x2 - pad) continue;
      // The ledge it is standing on scores gap 0 and drops out here, along with
      // anything else too close overhead to be worth the trouble.
      var gap = py - l.y;
      if (gap < CFG.FLY_GAP_MIN || gap > maxGap) continue;
      // Usually the full POP_CLEAR. Over the topmost ledge it is whatever is left
      // before the balloon runs out of window — a few px, but a few px above the
      // surface is all a landing needs.
      var clear = Math.min(CFG.POP_CLEAR, l.y - roof);
      if (clear < CFG.POP_MIN) continue;
      cands.push({ y: l.y, clear: clear });
    }
    if (!cands.length && !force) return false;

    // Pick at RANDOM, not nearest. tryHop takes the nearest thing below because a
    // fall stops at the first surface whatever it aimed at; a balloon has no such
    // excuse, and "nearest" quietly made the strip under the header unreachable —
    // on any real page there is a card somewhere in between, and the nearest rule
    // picks that card every single time. Random also just makes it a better
    // trick: you cannot tell where it is going until it stops going.
    var t = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
    var popY = t ? t.y - t.clear : roof;
    if (py - popY < 24) return false;                       // already up there
    fly = { popY: popY, x0: px, t0: 0 };
    flyReady = clock + CFG.FLY_COOLDOWN;
    // The ledge is kept through the wind-up, exactly as the crouch keeps it: a
    // cat interrupted halfway through inflating is still standing on something.
    setState('inflate');
    stateUntil = clock + CFG.INFLATE_MS;
    return true;
  }

  function toPop() {
    vy = 0;
    setState('pop');
    stateUntil = clock + CFG.POP_MS;
  }

  // `record` false means "stop being here", not "the user said no".
  function toLeave(record) {
    leaveRecords = record !== false;
    grab = null;
    fly = null;
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
    hop = null; hopFloor = -1e9; fly = null;
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

    if (state === 'inflate') {
      if (!ledge || !fly) { toFall(0, 0); return; }   // the ground left mid-inflate
      if (clock < stateUntil) return;
      ledge = null; wall = null; rot = 0;
      vx = 0; vy = 0;
      fly.x0 = px; fly.t0 = clock;
      setState('float');
      return;
    }

    // The one place gravity does not apply. Note this branch sits ABOVE the
    // fall/hop one deliberately — that branch adds GRAVITY unconditionally, and
    // a floating cat sharing it would be a cat with a balloon falling anyway.
    if (state === 'float') {
      if (!fly) { toFall(0, 0); return; }
      vy = Math.max(vy - CFG.FLY_LIFT * dt, -CFG.FLY_MAX_VY);
      py += vy * dt;
      // Sway is an oscillation about the launch column, not a drift: the target
      // ledge was chosen for being under THIS x, and a drift would wander off it.
      px = clamp(fly.x0 + Math.sin((clock - fly.t0) * 1.7) * CFG.FLY_SWAY,
        bounds.left + 6, bounds.right - 6);
      if (py <= fly.popY || py <= CFG.FLY_HEAD) toPop();   // never past the window
      return;
    }

    if (state === 'pop') {
      // Startled, and already dropping. The sideways kick is small on purpose:
      // over a POP_CLEAR-high drop it is worth a few px, and the pad in tryFly()
      // is sized to absorb exactly that. Make it bigger and the cat starts
      // missing the ledge it just spent six seconds floating up to.
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
    if (document.body.classList.contains('swal2-shown')) return;
    root.style.display = '';

    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.05);

    if (now - lastScan > CFG.RESCAN_MS) {
      lastScan = now;
      scan();
      // Every state that believes it is standing on a specific ledge object.
      // 'float' and 'pop' are airborne like fall/hop and must NOT be here; they
      // hold a bare y, not a ledge, precisely because ledges go stale on rescan.
      if (state === 'walk' || state === 'idle' || state === 'chase' ||
        state === 'land' || state === 'crouch' || state === 'inflate') refoot();
    }

    // A tab left open across the end of the debut must let the cat go too, or
    // the window only ends for people who happen to reload.
    if (autoDebut && state !== 'leave' && !inDebut()) toLeave(false);

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
        cat.classList.remove('yc-grabbed');
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
        vx: 0, vy: 0, moved: false, px0: px, py0: py, ledge0: ledge
      };
      ledge = null; wall = null; rot = 0;
      setState('drag');
      cat.classList.add('yc-grabbed');
    });

    cat.addEventListener('pointermove', function (e) {
      if (!grab || e.pointerId !== grab.id) return;
      var now = performance.now(), dt = Math.max(16, now - grab.t) / 1000;
      grab.vx = (e.clientX - grab.x) / dt;
      grab.vy = (e.clientY - grab.y) / dt;
      grab.x = e.clientX; grab.y = e.clientY; grab.t = now;
      if (Math.abs(e.clientX - grab.px0) > 4 || Math.abs(e.clientY - grab.py0) > 6) grab.moved = true;
      px = e.clientX;
      py = e.clientY + CFG.H * 0.45;      // dangles just below the cursor
      aim(grab.vx, 0);
      draw();
    });

    function release(e) {
      if (!grab || (e && e.pointerId !== grab.id)) return;
      var g = grab; grab = null;
      cat.classList.remove('yc-grabbed');
      // A poke: put it back where it was and let it notice you.
      if (!g.moved && performance.now() - g.t0 < 350) {
        px = g.px0; py = g.py0; rot = 0;
        ledge = g.ledge0;
        if (ledge) { setState('idle', 'look'); stateUntil = clock + rand(1.2, 2.5); }
        else toFall(0, 0);
        return;
      }
      toFall(clamp(g.vx * 0.35, -520, 520), clamp(g.vy * 0.35, -520, 520));
    }
    cat.addEventListener('pointerup', release);
    cat.addEventListener('pointercancel', release);
  }

  // ── Build / teardown ─────────────────────────────────────────────────────────
  // ── The introduction ─────────────────────────────────────────────────────────
  // Shown on every load during the debut, until the person makes a choice.
  // Without it the cat is just an unexplained animal on a case-management
  // screen, and the gesture that controls it is undiscoverable — so it keeps
  // offering itself rather than betting everything on one 14-second window.
  function showSay() {
    if (!root || say) return;
    say = document.createElement('div');
    say.className = 'yc-say';
    say.textContent = 'Hello! Long-press the logo to send me away — or to bring me back.';
    root.appendChild(say);
    requestAnimationFrame(function () { if (say) say.classList.add('show'); });
    setTimeout(hideSay, 14000);
  }

  function hideSay() {
    if (!say) return;
    var s = say;
    say = null;
    s.classList.remove('show');
    setTimeout(function () { s.remove(); }, 500);
  }

  function build() {
    styleEl = document.createElement('style');
    styleEl.id = 'yc-mascot-style';
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);

    root = document.createElement('div');
    root.id = 'yc-mascot';

    cat = document.createElement('div');
    cat.className = 'yc-cat';
    cat.innerHTML = SVG;
    cat.title = 'drag me · double-click to send me away';
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
    fly = null;
    flyReady = CFG.FLY_FIRST;      // it has to be here a while before it gets ideas
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

    function charge() { logo.classList.add('yc-charging'); }
    function discharge() { logo.classList.remove('yc-charging'); }

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
    else { store.set(true); autoDebut = false; start(); }
  }

  // ── Console control ──────────────────────────────────────────────────────────
  // Nothing in the file calls any of this; it exists so the cat can be made to do
  // a thing on demand instead of waiting for it to feel like it — which for the
  // balloon is otherwise a four-minute wait per attempt.
  //
  // `run` returns nothing when the action took, or a STRING saying why it did
  // not. A console command that silently does nothing is worse than one that
  // says "no wall in reach" — you cannot tell a refusal from a broken build.
  var ACTIONS = [
    { name: 'walk', needs: 'ledge', what: 'set off along the ledge it is on', run: function () { toWalk(); } },
    { name: 'idle', needs: 'ledge', what: 'stop, and roll one of the idle acts', run: function () { toIdle(); } },
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
      name: 'fly', needs: 'ledge', what: 'the balloon. Ignores the cooldown, and bursts on the ceiling if nothing is overhead',
      run: function () { if (!tryFly(true)) return 'no room above it to rise'; }
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
        ledge = null; wall = null; fly = null;
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
            if (a === 'sleep') face = 1;      // …or the z's come out mirrored
            stateUntil = clock + (a === 'sleep' ? rand(6, 12) : rand(3, 6));
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
      console.warn('[Mascot] not out — Mascot.on(), or long-press the logo');
      return false;
    }
    if (name == null) name = ACTIONS[Math.floor(Math.random() * ACTIONS.length)].name;
    var a = findAction(name);
    if (!a) { console.warn('[Mascot] no action "' + name + '" — try Mascot.list()'); return false; }
    // 'drag' and every airborne state have no ledge, so this one test covers all
    // the ways the cat can be in no position to oblige.
    if (a.needs === 'ledge' && !ledge) {
      console.warn('[Mascot] ' + a.name + ' needs it standing on something (state: ' + state + ')');
      return false;
    }
    var why = a.run();
    if (typeof why === 'string') { console.warn('[Mascot] ' + a.name + ': ' + why); return false; }
    draw();          // so the new pose shows at once, even mid-freeze
    return a.name;
  }

  window.Mascot = {
    on: function () { store.set(true); start(); },
    off: function () { store.set(false); stop(); },
    toggle: toggle,
    'do': doAction,
    list: function () {
      var rows = [], names = [];
      for (var i = 0; i < ACTIONS.length; i++) {
        rows.push({ call: 'Mascot.' + ACTIONS[i].name + '()', needs: ACTIONS[i].needs, what: ACTIONS[i].what });
        names.push(ACTIONS[i].name);
      }
      try { console.table(rows); } catch (e) { console.log(rows); }
      console.log('Mascot.do("name") runs one by name · Mascot.do() rolls a random one');
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
        // Seconds until a balloon is possible again. 0 means the only thing left
        // between you and one is the roll in toIdle() and something to fly to.
        balloonIn: Math.max(0, Math.round(flyReady - clock)),
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

  // One shorthand per action — Mascot.fly(), Mascot.sleep(), Mascot.jump()…
  // Guarded so an action can never quietly overwrite on/off/toggle/list/debug if
  // someone adds one called 'toggle' later.
  (function () {
    for (var i = 0; i < ACTIONS.length; i++) {
      (function (n) {
        if (window.Mascot[n]) return;
        window.Mascot[n] = function () { return doAction(n); };
      })(ACTIONS[i].name);
    }
  })();

  function boot() {
    wireTrigger();
    var pref = store.pref();
    if (pref === '1') start();                       // asked for it
    else if (pref === null && inDebut()) {           // no opinion, and still the debut
      autoDebut = true;
      start();
      showSay();                                     // every load until they decide
    }
    // Wired once, at boot rather than per build(), so on/off cycles don't stack
    // up duplicate listeners. It only feeds the occasional cursor chase.
    document.addEventListener('pointermove', function (e) {
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.t = clock;
    }, { passive: true });
    window.addEventListener('resize', function () { lastScan = -1e9; });
  }
  // NOTE: boot() is called at the very BOTTOM of this file, not here. This script
  // is deferred, so readyState is already "interactive" and boot() would run
  // synchronously — before the SVG and CSS below have been assigned. That put the
  // string "undefined" in the cat and in the stylesheet, but only for someone who
  // already had the pref set, because a long-press happens long after evaluation.

  // ── The sprite ───────────────────────────────────────────────────────────────
  // 36×28, side view, facing right, feet on the bottom edge of the box. Parts are
  // grouped so the CSS below can pose them per state.
  //
  // The fills below stay literal, and the theme arc left them alone on purpose.
  // This is ARTWORK, not chrome: a ginger cat has to read as a ginger cat in
  // both modes, and there is no token for "cat". Dark mode is handled the way
  // artwork should be -- .yc-cat lifts to brightness(1.08) and a deeper
  // drop-shadow -- not by repainting the sprite. The two pieces of this widget
  // that ARE app UI, the speech bubble and the sleep z's, are tokenised below.
  var SVG =
    '<svg class="m-svg" viewBox="0 0 36 28" width="36" height="28" aria-hidden="true" focusable="false">' +
    // The balloon lives ABOVE the viewBox, which works because the svg is
    // overflow:visible (the sleep z's already do it). It sits outside .m-all so
    // it does not inherit the body's bob and squash — and so the cat can swing
    // underneath it during the float while the balloon itself stays put.
    // Its crown is at viewBox y −23.8, i.e. CFG.FLY_HEAD above the feet at y 28.
    // Change the geometry here and FLY_HEAD has to change with it.
    '<g class="m-bal">' +
    '<path class="m-string" d="M20 -3 q-3 7 -2.4 10.5 q.4 2.4 -.6 3.9" fill="none" stroke="#B0783A" stroke-width=".9" stroke-linecap="round"/>' +
    '<g class="m-balloon">' +
    '<ellipse cx="20" cy="-14" rx="8.3" ry="9.8" fill="#E4574C"/>' +
    '<ellipse cx="16.8" cy="-18" rx="2.4" ry="3.2" fill="#F6A79F" opacity=".8"/>' +
    '<path d="M18.4 -4.5 L21.6 -4.5 L20 -1.7 Z" fill="#C4443A"/>' +
    '</g>' +
    // Shards start ON the rim and fly outward, rather than growing out of the
    // middle — a burst radiating from the centre just paints over the skin that
    // is still fading and reads as a smudge, not a pop.
    '<g class="m-shards">' +
    '<path d="M11.7 -14 l-4.6 -.6 M28.3 -14 l4.6 -.6 M20 -23.8 l.6 -4.6' +
    ' M14.1 -20.9 l-3.2 -3.4 M25.9 -20.9 l3.2 -3.4' +
    ' M14.1 -7.1 l-3.2 3.2 M25.9 -7.1 l3.2 3.2"' +
    ' fill="none" stroke="#E4574C" stroke-width="1.7" stroke-linecap="round"/>' +
    '</g></g>' +
    '<g class="m-all">' +
    '<path class="m-tail" d="M6 15 C1 15.5 -0.5 9 2.5 5.5" fill="none" stroke="#D9762F" stroke-width="2.8" stroke-linecap="round"/>' +
    '<g class="m-leg m-bl"><rect x="8" y="17.5" width="3.4" height="10.5" rx="1.7" fill="#CE7130"/></g>' +
    '<g class="m-leg m-fl"><rect x="19" y="17.5" width="3.4" height="10.5" rx="1.7" fill="#CE7130"/></g>' +
    '<rect class="m-body" x="5" y="11" width="23" height="11" rx="5.5" fill="#E8833A"/>' +
    '<path class="m-stripe" d="M11 12.2v3.4 M15 12v4 M19 12.2v3.4" stroke="#C96A28" stroke-width="1.6" stroke-linecap="round"/>' +
    '<g class="m-leg m-br"><rect x="11.6" y="17.5" width="3.4" height="10.5" rx="1.7" fill="#E8833A"/></g>' +
    '<g class="m-leg m-fr"><rect x="22.6" y="17.5" width="3.4" height="10.5" rx="1.7" fill="#E8833A"/></g>' +
    '<g class="m-head">' +
    '<path d="M23.6 8.4 L25.2 2.4 L28.8 6.6 Z" fill="#E8833A"/>' +
    '<path d="M31 5.4 L33.8 1.8 L34.6 7 Z" fill="#D9762F"/>' +
    '<circle cx="29.4" cy="10" r="6.2" fill="#EE8F45"/>' +
    '<circle class="m-eye" cx="31.9" cy="8.9" r="1.15" fill="#2A2118"/>' +
    '<path class="m-lid" d="M30.5 8.9 h2.8" stroke="#2A2118" stroke-width="1.3" stroke-linecap="round"/>' +
    '<circle cx="34.2" cy="11.4" r="1" fill="#F7DCC1"/>' +
    '<path d="M33.2 13.2 q1 .9 2 .1" stroke="#C96A28" stroke-width=".8" fill="none" stroke-linecap="round"/>' +
    '</g></g>' +
    '<g class="m-zzz">' +
    '<text class="m-z1" x="32" y="1">z</text>' +
    '<text class="m-z2" x="35" y="-4">z</text>' +
    '</g></svg>';

  // ── Styles ───────────────────────────────────────────────────────────────────
  var CSS = [
    '#yc-mascot{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:' + CFG.Z + ';}',
    '@media print{#yc-mascot{display:none!important}}',
    '.yc-cat{position:absolute;left:0;top:0;width:' + CFG.W + 'px;height:' + CFG.H + 'px;',
    // LOAD-BEARING. draw() composes rotate/scaleX about the element's origin;
    // the CSS default of 50% 50% pivots about the sprite's centre instead and
    // throws the cat 32px off its anchor — invisibly at rot:0, but every climb
    // and hang lands beside the wall rather than on it.
    'transform-origin:0 0;',
    'pointer-events:auto;cursor:grab;touch-action:none;will-change:transform;',
    'filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.30));}',
    '.yc-cat.yc-grabbed{cursor:grabbing}',
    '.yc-say{position:absolute;left:0;top:0;max-width:250px;padding:8px 12px;border-radius:13px;',
    // The bubble is a small panel of app UI, so it takes app tokens and the
    // hand-picked dark override collapses into them -- the family-C pattern.
    // Was #fff/#1f2430/#d8dde3 light and #2b3039/#e9ecf1/#3b424c dark.
    'background:var(--surface);color:var(--text);border:1px solid var(--border);box-shadow:0 4px 14px rgba(0,0,0,.16);',
    'font:500 12.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;',
    'pointer-events:none;opacity:0;transition:opacity .45s ease;will-change:transform}',
    '.yc-say.show{opacity:1}',
    'html[data-theme="dark"] .yc-cat{filter:drop-shadow(0 1px 2px rgba(0,0,0,.55)) brightness(1.08)}',
    '.yc-cat svg{display:block;overflow:visible}',
    '.yc-cat g,.yc-cat path,.yc-cat rect,.yc-cat text{transform-box:view-box}',

    /* pivots: legs swing from the hip, the head from the neck, the tail from the rump */
    '.m-bl{transform-origin:9.7px 18.5px}.m-br{transform-origin:13.3px 18.5px}',
    '.m-fl{transform-origin:20.7px 18.5px}.m-fr{transform-origin:24.3px 18.5px}',
    '.m-head{transform-origin:25px 12px}.m-tail{transform-origin:6px 15px}',
    '.m-all{transform-origin:18px 28px}',
    '.m-leg,.m-head,.m-tail,.m-all{transition:transform .18s ease-out}',

    /* the walk is two frames on purpose — the stutter is what makes it 1995 */
    '@keyframes ycm-legA{0%,49%{transform:rotate(17deg)}50%,100%{transform:rotate(-17deg)}}',
    '@keyframes ycm-legB{0%,49%{transform:rotate(-17deg)}50%,100%{transform:rotate(17deg)}}',
    '@keyframes ycm-bob{0%,49%{transform:translateY(0)}50%,100%{transform:translateY(-1px)}}',
    '@keyframes ycm-tail{0%{transform:rotate(-9deg)}50%{transform:rotate(11deg)}100%{transform:rotate(-9deg)}}',
    '@keyframes ycm-blinkLid{0%,95.5%,100%{opacity:0}96.5%,98.5%{opacity:1}}',
    '@keyframes ycm-blinkEye{0%,95.5%,100%{opacity:1}96.5%,98.5%{opacity:0}}',
    '.m-lid{opacity:0;animation:ycm-blinkLid 5.3s infinite}',
    '.m-eye{animation:ycm-blinkEye 5.3s infinite}',

    /* walk / chase / climb share a gait, at different tempos */
    '[data-state="walk"] .m-fr,[data-state="walk"] .m-bl,',
    '[data-state="chase"] .m-fr,[data-state="chase"] .m-bl,',
    '[data-state="climb"] .m-fr,[data-state="climb"] .m-bl,',
    '[data-state="hang"] .m-fr,[data-state="hang"] .m-bl{animation:ycm-legA .26s infinite}',
    '[data-state="walk"] .m-fl,[data-state="walk"] .m-br,',
    '[data-state="chase"] .m-fl,[data-state="chase"] .m-br,',
    '[data-state="climb"] .m-fl,[data-state="climb"] .m-br,',
    '[data-state="hang"] .m-fl,[data-state="hang"] .m-br{animation:ycm-legB .26s infinite}',
    '[data-state="walk"] .m-all,[data-state="chase"] .m-all{animation:ycm-bob .26s infinite}',
    '[data-state="chase"] .m-fr,[data-state="chase"] .m-bl,',
    '[data-state="chase"] .m-fl,[data-state="chase"] .m-br{animation-duration:.17s}',
    '[data-state="climb"] .m-fr,[data-state="climb"] .m-bl,',
    '[data-state="climb"] .m-fl,[data-state="climb"] .m-br{animation-duration:.34s}',
    '[data-state="hang"] .m-fr,[data-state="hang"] .m-bl,',
    '[data-state="hang"] .m-fl,[data-state="hang"] .m-br{animation-duration:.42s}',
    '[data-state="walk"] .m-tail,[data-state="idle"] .m-tail{animation:ycm-tail 1.15s ease-in-out infinite}',
    '[data-state="chase"] .m-tail{animation:ycm-tail .5s ease-in-out infinite}',

    /* airborne: legs splay, tail streams */
    '[data-state="fall"] .m-fl,[data-state="fall"] .m-fr{transform:rotate(-34deg)}',
    '[data-state="fall"] .m-bl,[data-state="fall"] .m-br{transform:rotate(30deg)}',
    '[data-state="fall"] .m-tail{transform:rotate(-32deg)}',
    '[data-state="fall"] .m-head{transform:rotate(-8deg)}',

    /* dropping to a lower perch: the wind-up, then the tuck. The .18s transition
       on .m-all is what makes the crouch read as a gather rather than a pop. */
    '[data-state="crouch"] .m-all{transform:translateY(3px) scaleY(.80) scaleX(1.09)}',
    '[data-state="crouch"] .m-head{transform:rotate(7deg)}',      /* eyeing the landing */
    '[data-state="crouch"] .m-tail{transform:rotate(-20deg)}',
    '[data-state="hop"] .m-fl,[data-state="hop"] .m-fr{transform:rotate(-26deg)}',
    '[data-state="hop"] .m-bl,[data-state="hop"] .m-br{transform:rotate(22deg)}',
    '[data-state="hop"] .m-tail{transform:rotate(-30deg)}',
    '[data-state="hop"] .m-head{transform:rotate(6deg)}',
    '[data-state="hop"] .m-all{transform:scaleY(1.06) scaleX(.95)}',

    /* ── the balloon ─────────────────────────────────────────────────────────
       Shown ONLY by these three state selectors, and hidden by default. That is
       load-bearing, not tidiness: it means toLeave(), a drag, the debut expiring
       and every other way out of a float all put the balloon away for free,
       without a single one of them having to know it exists. */
    '.m-bal{opacity:0}',
    '[data-state="inflate"] .m-bal,[data-state="float"] .m-bal,[data-state="pop"] .m-bal{opacity:1}',
    '.m-balloon{transform-origin:20px -3.5px}',   /* the knot — it fills from there */
    '.m-shards{transform-origin:20px -14px;opacity:0}',
    '@keyframes ycm-inflate{0%{transform:scale(.05)}60%{transform:scale(1.11)}80%{transform:scale(.97)}100%{transform:scale(1)}}',
    '@keyframes ycm-bobble{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}',
    /* the skin goes early and the shards outlive it, or the two overlap for most
       of the burst and it reads as the balloon melting rather than popping */
    '@keyframes ycm-burst{0%{transform:scale(1);opacity:1}30%{transform:scale(1.24);opacity:.5}55%,100%{transform:scale(1.32);opacity:0}}',
    '@keyframes ycm-shards{0%{transform:scale(1);opacity:1}70%{opacity:.9}100%{transform:scale(2);opacity:0}}',
    '@keyframes ycm-swing{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(7deg)}}',
    '[data-state="inflate"] .m-balloon{animation:ycm-inflate ' + CFG.INFLATE_MS + 's ease-out both}',
    '[data-state="inflate"] .m-all{transform:translateY(2px) scaleY(.94) scaleX(1.05)}',
    '[data-state="inflate"] .m-head{transform:rotate(-17deg)}',   /* watching it fill */
    '[data-state="inflate"] .m-tail{transform:rotate(-12deg)}',
    '[data-state="float"] .m-balloon{animation:ycm-bobble 2.9s ease-in-out infinite}',
    /* the pivot moves to the KNOT for the float, so the cat swings from the
       string like a pendulum instead of about its own feet. The balloon is
       outside .m-all, so it holds still while the cat sways under it. */
    '[data-state="float"] .m-all{transform-origin:20px -2px;animation:ycm-swing 2.4s ease-in-out infinite}',
    /* NOT a dangle on all four: four legs swinging in antiphase is a gait, and a
       floating cat that appears to be walking is the whole illusion gone. The
       front pair holds the splay the fall pose uses — which already reads as
       airborne — and only the back pair swings, slowly enough to be a sway. */
    '[data-state="float"] .m-fl,[data-state="float"] .m-fr{transform:rotate(-18deg)}',
    '[data-state="float"] .m-bl,[data-state="float"] .m-br{animation:ycm-dangle 1.7s ease-in-out infinite}',
    '[data-state="float"] .m-br{animation-delay:.85s}',
    '[data-state="float"] .m-tail{transform:rotate(16deg)}',
    '[data-state="float"] .m-head{transform:rotate(-7deg)}',
    '[data-state="pop"] .m-balloon{animation:ycm-burst ' + CFG.POP_MS + 's ease-out forwards}',
    '[data-state="pop"] .m-shards{opacity:1;animation:ycm-shards ' + CFG.POP_MS + 's ease-out forwards}',
    '[data-state="pop"] .m-string{opacity:0}',
    '[data-state="pop"] .m-head{transform:rotate(-15deg)}',       /* startled */
    '[data-state="pop"] .m-fl,[data-state="pop"] .m-fr{transform:rotate(-38deg)}',
    '[data-state="pop"] .m-bl,[data-state="pop"] .m-br{transform:rotate(34deg)}',
    '[data-state="pop"] .m-all{transform:scaleY(.94) scaleX(1.07)}',

    /* the landing squash */
    '@keyframes ycm-land{0%{transform:scaleY(.68) scaleX(1.18)}60%{transform:scaleY(1.06) scaleX(.96)}100%{transform:none}}',
    '[data-state="land"] .m-all{animation:ycm-land .22s ease-out}',

    /* held by the scruff */
    '@keyframes ycm-dangle{0%{transform:rotate(-14deg)}50%{transform:rotate(14deg)}100%{transform:rotate(-14deg)}}',
    '[data-state="drag"] .m-leg{animation:ycm-dangle .32s ease-in-out infinite}',
    '[data-state="drag"] .m-br,[data-state="drag"] .m-fr{animation-delay:.16s}',
    '[data-state="drag"] .m-tail{transform:rotate(-24deg)}',

    /* idle repertoire */
    '[data-act="sit"] .m-all{transform:translateY(2px)}',
    '[data-act="sit"] .m-bl,[data-act="sit"] .m-br{transform:rotate(62deg)}',
    '@keyframes ycm-look{0%,20%{transform:rotate(0)}35%,50%{transform:rotate(-15deg)}65%,80%{transform:rotate(13deg)}100%{transform:rotate(0)}}',
    '[data-act="look"] .m-head{animation:ycm-look 3.4s ease-in-out infinite}',
    '@keyframes ycm-groomH{0%,100%{transform:rotate(0)}40%,70%{transform:rotate(26deg) translateY(1px)}}',
    '@keyframes ycm-groomP{0%,100%{transform:rotate(0)}40%{transform:rotate(-64deg)}55%{transform:rotate(-52deg)}70%{transform:rotate(-64deg)}}',
    '[data-act="groom"] .m-head{animation:ycm-groomH 1.8s ease-in-out infinite}',
    '[data-act="groom"] .m-fr{animation:ycm-groomP 1.8s ease-in-out infinite}',
    '[data-act="groom"] .m-all{transform:translateY(2px)}',
    '@keyframes ycm-stretch{0%,100%{transform:none}45%{transform:scaleX(1.16) scaleY(.86) translateY(2px)}}',
    '[data-act="stretch"] .m-all{animation:ycm-stretch 2.2s ease-in-out infinite}',
    '[data-act="stretch"] .m-tail{transform:rotate(-34deg)}',
    '@keyframes ycm-scratch{0%,100%{transform:rotate(-58deg)}50%{transform:rotate(-44deg)}}',
    '[data-act="scratch"] .m-bl{animation:ycm-scratch .13s infinite}',
    '[data-act="scratch"] .m-all{transform:translateY(2px)}',
    '[data-act="scratch"] .m-head{transform:rotate(-9deg)}',

    /* asleep — the cat always faces right here so the z\'s are never mirrored */
    '[data-act="sleep"] .m-all{transform:translateY(4px) scaleY(.82) scaleX(1.05)}',
    '[data-act="sleep"] .m-leg{transform:rotate(72deg)}',
    '[data-act="sleep"] .m-lid{opacity:1;animation:none}',
    '[data-act="sleep"] .m-eye{opacity:0;animation:none}',
    '[data-act="sleep"] .m-tail{transform:rotate(24deg)}',
    '.m-zzz{opacity:0}',
    // Same collapse: the z's are muted text over the page. Was #8a8f98 light
    // (2.90 on --page-bg) and #c8ced8 dark; --text-muted is 5.69 / 5.93.
    '.m-zzz text{font:italic 700 7px/1 Georgia,serif;fill:var(--text-muted);',
    'transform-box:fill-box;transform-origin:50% 50%}',   /* each z scales about itself */
    '@keyframes ycm-z{0%{opacity:0;transform:translate(0,0) scale(.7)}25%{opacity:.9}100%{opacity:0;transform:translate(4px,-9px) scale(1.1)}}',
    '[data-act="sleep"] .m-zzz{opacity:1}',
    '[data-act="sleep"] .m-z1{animation:ycm-z 2.6s ease-out infinite}',
    '[data-act="sleep"] .m-z2{animation:ycm-z 2.6s ease-out infinite 1.3s}',

    /* the trigger: the logo visibly charges while you hold it */
    '.hdr-logo.yc-charging{transform:scale(.86);opacity:.6;',
    'transition:transform ' + CFG.HOLD_MS + 'ms ease-in,opacity ' + CFG.HOLD_MS + 'ms ease-in;}'
  ].join('\n');

  // Last line on purpose — everything the cat is made of has to exist first.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
