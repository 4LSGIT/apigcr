/* public/js/mascot.js
 * ───────────────────────────────────────────────────────────────────────────────
 * THE CAT (an easter egg)
 *
 * A Win95-style desktop pet for the YisraCase shell. It wanders, sits, grooms,
 * sleeps, climbs the walls, hangs off the ceiling, falls off ledges, and — the
 * whole reason it is worth doing here — walks along the tops of the real tables
 * and cards inside whatever page is open, because every content page in this
 * shell is a SAME-ORIGIN iframe and `contentDocument` is readable.
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
    CLIMB: 34,
    HANGSPEED: 30,
    CHASE: 92,
    HOLD_MS: 900,          // long-press duration on the logo
    Z: 900,
    MIN_VW: 900,           // below this the shell is in mobile layout — no cat
    RESCAN_MS: 1200,       // platform rescan throttle
    MAX_PLATFORMS: 40,
    KEY: 'yc.mascot.on'    // matches the yc.* convention in scripts.js
  };

  // Elements inside the open page that are chunky enough to stand on.
  var FRAME_SEL = 'table, thead, .card, .panel, fieldset, h1, h2, h3, .swal2-popup';

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
  var store = (function () {
    try {
      localStorage.getItem(CFG.KEY);
      return {
        get: function () { try { return localStorage.getItem(CFG.KEY) === '1'; } catch (e) { return false; } },
        set: function (v) { try { v ? localStorage.setItem(CFG.KEY, '1') : localStorage.removeItem(CFG.KEY); } catch (e) { } }
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

  var ledges = [], walls = [], lastScan = -1e9;

  // ── Small helpers ────────────────────────────────────────────────────────────
  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function visible(el) { return !!el && el.getClientRects().length > 0; }
  function vw() { return window.innerWidth; }
  function vh() { return window.innerHeight; }

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
    var L = [{ x1: 0, x2: W, y: H }];                       // the floor
    var A = [
      { x: 1, y1: 0, y2: H, rot: 90 },                      // left viewport wall
      { x: W - 1, y1: 0, y2: H, rot: -90 }                  // right viewport wall
    ];

    // The header's underside is the classic ledge — a cat walking along the
    // bottom edge of a window, drawn over the window itself.
    var hdr = document.getElementById('appHeader');
    if (visible(hdr)) {
      var hr = hdr.getBoundingClientRect();
      if (hr.bottom > 10 && hr.bottom < H - 10) L.push({ x1: hr.left, x2: hr.right, y: hr.bottom });
    }

    // The sidebar's right edge is a wall worth climbing.
    var sb = document.getElementById('appSidebar');
    if (visible(sb)) {
      var sr = sb.getBoundingClientRect();
      if (sr.width > 24 && sr.right < W - 40) A.push({ x: sr.right, y1: sr.top, y2: sr.bottom, rot: 90 });
    }

    frameLedges(L, W, H);

    ledges = L;
    walls = A;
  }

  // Reach into the open page and collect the tops of its real furniture.
  // Every step is defensive: the frame may be cross-origin one day, may not have
  // loaded, may be mid-navigation. Any failure just means shell-only platforms.
  function frameLedges(out, W, H) {
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
    } catch (e) { return; }
    if (!frame) return;

    var doc;
    try { doc = frame.contentDocument; } catch (e) { return; }   // cross-origin
    if (!doc || !doc.body) return;

    var box = frame.getBoundingClientRect();
    var top = Math.max(box.top, 0), bot = Math.min(box.bottom, H);
    var els;
    try { els = doc.querySelectorAll(FRAME_SEL); } catch (e) { return; }

    var found = [], seen = {}, n = Math.min(els.length, 250);
    for (var k = 0; k < n; k++) {
      var r;
      try { r = els[k].getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < 120 || r.height < 24) continue;
      // Child rects are relative to the FRAME's viewport, so scrolling is already
      // baked in — the only correction needed is the frame's own offset.
      var y = box.top + r.top;
      if (y < top + 8 || y > bot - 8) continue;
      var x1 = Math.max(box.left + r.left, box.left, 0);
      var x2 = Math.min(box.left + r.right, box.right, W);
      if (x2 - x1 < 70) continue;
      // A table and its thead share a top edge; one ledge is enough.
      var key = Math.round(y / 4) + ':' + Math.round(x1 / 8);
      if (seen[key]) continue;
      seen[key] = 1;
      found.push({ x1: x1, x2: x2, y: y, area: (x2 - x1) * r.height });
    }
    found.sort(function (a, b) { return b.area - a.area; });
    for (var j = 0; j < found.length && j < CFG.MAX_PLATFORMS; j++) {
      out.push({ x1: found[j].x1, x2: found[j].x2, y: found[j].y });
    }
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
    else { ledge = null; setState('fall'); vx = 0; vy = 0; }
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
  }

  function toIdle() {
    setState('idle', pick(IDLE_ACTS));
    // A sleeping cat always faces right, so the floating z's are never mirrored.
    if (act === 'sleep') face = 1;
    stateUntil = clock + (act === 'sleep' ? rand(4, 9) : rand(1.8, 4.5));
  }

  function toFall(ivx, ivy) {
    ledge = null; wall = null;
    vx = ivx || 0; vy = ivy || 0;
    rot = 0;
    setState('fall');
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
      if (px < -50 || px > W + 50) { stop(); store.set(false); }
      return;
    }

    if (state === 'land') {
      if (clock >= stateUntil) toWalk();
      return;
    }

    if (state === 'fall') {
      vy = Math.min(vy + CFG.GRAVITY * dt, CFG.TERMINAL);
      var y0 = py;
      px += vx * dt;
      py += vy * dt;
      if (px < 4) { px = 4; vx = Math.abs(vx) * 0.4; }
      if (px > W - 4) { px = W - 4; vx = -Math.abs(vx) * 0.4; }
      var hit = ledgeBelow(px, y0, py);
      if (hit) { land(hit); }
      else if (py >= H) { land({ x1: 0, x2: W, y: H }); }
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
        if (w.y1 <= 2) {                         // the ceiling — hang from it
          wall = null; rot = 180; py = 0;
          aim(px > W / 2 ? -1 : 1, 0);           // head back towards the middle
          setState('hang');
          stateUntil = clock + rand(2, 6);
        } else {
          var l = ledgeBelow(px, w.y1 - 2, w.y1 + 6);
          if (l) { land(l); aim(px > W / 2 ? -1 : 1, 0); } else face = -face;
        }
        return;
      }
      if (!up && py >= w.y2 - 1) {
        py = w.y2 - 1;
        var l2 = ledgeBelow(px, py - 4, py + 10);
        // Step off towards open space, or it just paces against the wall.
        if (l2) { land(l2); aim(px > W / 2 ? -1 : 1, 0); } else face = -face;
        return;
      }
      // Cats also just let go sometimes.
      if (clock >= stateUntil && Math.random() < 0.5) {
        toFall((px < W / 2 ? 1 : -1) * 30, -40);
      } else if (clock >= stateUntil) {
        stateUntil = clock + rand(1.5, 4);
        face = -face;
      }
      return;
    }

    if (state === 'hang') {
      var fh = fwd();
      px += fh.x * face * CFG.HANGSPEED * dt;
      if (px < 6 || px > W - 6) {
        px = clamp(px, 6, W - 6);
        var wcl = wallNear(px, 4);
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
      if (state === 'walk' || state === 'idle' || state === 'chase' || state === 'land') refoot();
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
        grab = null;
        cat.classList.remove('yc-grabbed');
        rot = 0;
        face = px < vw() / 2 ? -1 : 1;
        setState('leave');
        e.preventDefault();
        return;
      }
      lastDown = now;
      e.preventDefault();
      try { cat.setPointerCapture(e.pointerId); } catch (err) { }
      grab = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0 };
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
      px = e.clientX;
      py = e.clientY + CFG.H * 0.45;      // dangles just below the cursor
      aim(grab.vx, 0);
      draw();
    });

    function release(e) {
      if (!grab || (e && e.pointerId !== grab.id)) return;
      var g = grab; grab = null;
      cat.classList.remove('yc-grabbed');
      toFall(clamp(g.vx * 0.35, -520, 520), clamp(g.vy * 0.35, -520, 520));
    }
    cat.addEventListener('pointerup', release);
    cat.addEventListener('pointercancel', release);
  }

  // ── Build / teardown ─────────────────────────────────────────────────────────
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
    px = vw() * rand(0.35, 0.65);
    py = -40;
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
    if (running) { rot = 0; face = px < vw() / 2 ? -1 : 1; setState('leave'); }
    else { store.set(true); start(); }
  }

  window.Mascot = {
    on: function () { store.set(true); start(); },
    off: function () { store.set(false); stop(); },
    toggle: toggle
  };

  function boot() {
    wireTrigger();
    // Wired once, at boot rather than per build(), so on/off cycles don't stack
    // up duplicate listeners. It only feeds the occasional cursor chase.
    document.addEventListener('pointermove', function (e) {
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.t = clock;
    }, { passive: true });
    window.addEventListener('resize', function () { lastScan = -1e9; });
    if (store.get()) start();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // ── The sprite ───────────────────────────────────────────────────────────────
  // 36×28, side view, facing right, feet on the bottom edge of the box. Parts are
  // grouped so the CSS below can pose them per state.
  var SVG =
    '<svg class="m-svg" viewBox="0 0 36 28" width="36" height="28" aria-hidden="true" focusable="false">' +
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
    'pointer-events:auto;cursor:grab;touch-action:none;will-change:transform;',
    'filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.30));}',
    '.yc-cat.yc-grabbed{cursor:grabbing}',
    'body.dark .yc-cat{filter:drop-shadow(0 1px 2px rgba(0,0,0,.55)) brightness(1.08)}',
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
    '.m-zzz text{font:italic 700 7px/1 Georgia,serif;fill:#8a8f98;',
    'transform-box:fill-box;transform-origin:50% 50%}',   /* each z scales about itself */
    'body.dark .m-zzz text{fill:#c8ced8}',
    '@keyframes ycm-z{0%{opacity:0;transform:translate(0,0) scale(.7)}25%{opacity:.9}100%{opacity:0;transform:translate(4px,-9px) scale(1.1)}}',
    '[data-act="sleep"] .m-zzz{opacity:1}',
    '[data-act="sleep"] .m-z1{animation:ycm-z 2.6s ease-out infinite}',
    '[data-act="sleep"] .m-z2{animation:ycm-z 2.6s ease-out infinite 1.3s}',

    /* the trigger: the logo visibly charges while you hold it */
    '.hdr-logo.yc-charging{transform:scale(.86);opacity:.6;',
    'transition:transform ' + CFG.HOLD_MS + 'ms ease-in,opacity ' + CFG.HOLD_MS + 'ms ease-in;}'
  ].join('\n');
})();
