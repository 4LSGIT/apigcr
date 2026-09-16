/* public/js/mascot/engine.js
 * ───────────────────────────────────────────────────────────────────────────────
 * THE MASCOT ENGINE (an easter egg)
 *
 * A Win95-style desktop pet for the YisraCase shell. It wanders, sits, sleeps,
 * climbs the walls, hangs off the ceiling, falls off ledges, and — the whole
 * reason it is worth doing here — walks along the tops of the real tables,
 * cards and buttons inside whatever page is open, dropping down onto a lower
 * one when it sees a landing it likes, because every content page in this shell
 * is a SAME-ORIGIN iframe and `contentDocument` is readable.
 *
 * WHICH animal it is lives somewhere else. This file is the ENGINE — the
 * physics, the platform scanning, the state machine, the drag, the bubble, the
 * console API — and it is character-blind: it sets `cat.dataset.state` and
 * `cat.dataset.act`, and everything visible about the animal comes from a SKIN,
 * a data object registered from /js/mascot/skins/<id>.js. Casey the ginger cat
 * is the reference skin; Casey-95 the robot is the proof there can be two.
 * And it is always the same CASEY — one cat, many FORMS: a skin is what Casey
 * turns up as, not a different animal. So the tile, the panel and the tooltip
 * say "Casey" whichever skin is active, and a skin's `name` only ever labels
 * its card in the form picker.
 * (They used to be an 84KB copy-paste fork of each other. Measured before the
 * merge: 1030 raw diff lines, of which ~25 were engine logic — the rest was the
 * artwork this contract now carries.)
 *
 * ── THE SKIN CONTRACT ────────────────────────────────────────────────────────
 *   Mascot.register({
 *     id: 'casey',              // matches the file name under skins/
 *     name: 'Casey',            // labels this form's card in the picker ONLY —
 *                               // the pet itself is called Casey everywhere
 *     blurb: 'A ginger cat.',   // one picker line; a rowdy skin says so HERE
 *     geom: { W: 36, H: 28, FLY_HEAD: 52 },
 *                               // sprite box, and how far the tallest thing
 *                               // (balloon crown, robot ears) rises above the
 *                               // feet — tryFly()'s headroom arithmetic
 *     tune: { FLY_LIFT: 260 },  // optional CFG overrides; unnamed knobs keep
 *                               // the engine defaults. Z is off limits — the
 *                               // z-order promise below is not per-skin.
 *     can: ['walk','hop',…],    // which engine STATES this skin may enter.
 *                               // Omitted = all of them. ENFORCED at the
 *                               // entry points for the optional states —
 *                               // climb, hang, chase, hop (with crouch),
 *                               // the inflate/float/pop ascent, and the
 *                               // noclip pair drift/blink (blink needs
 *                               // drift; drifting also needs DRIFT_CHANCE
 *                               // tuned above zero) — and in the
 *                               // console/panel, where a gated action is
 *                               // simply not offered: list() leaves it out
 *                               // and do() answers that it is not in this
 *                               // form's repertoire. The core six — walk,
 *                               // idle, fall, land, drag, leave — cannot be
 *                               // opted out of, and register() holds a `can`
 *                               // to listing them (plus hop⇒crouch, and the
 *                               // ascent as all-three-or-none).
 *     acts: [ ['sit',26], ['sleep',14,{face:1,dur:[4,9],cmdDur:[6,12]}] ],
 *                               // the idle repertoire, weighted. The optional
 *                               // third slot: face pins the sprite direction
 *                               // for the act (a sleeper faces right so the
 *                               // z's are never mirrored), dur is the ambient
 *                               // [min,max] seconds, cmdDur the console's.
 *     lookAct: 'scan',          // which act is "it noticed you" — a poke, a
 *                               // caught chase. Default 'look'; must name one
 *                               // of the acts.
 *     web: { chance: .35,       // optional: odds a finished sit leaves a web
 *            act: 'spin',       // …only after this idle act, if named
 *            life: 45,          // s before it fades out on its own
 *            max: 5,            // hard cap; oldest goes first
 *            w: 30, h: 26,      // the web's rect: spawn veto + break centre
 *            breakR: 18,        // px — the POINTER coming this close breaks
 *                               // it. That is §2a's whole implementation: a
 *                               // distance test against the cursor the
 *                               // engine already tracks, so a web never has
 *                               // pointer events, a touch tap breaks it on
 *                               // first contact, and a same-frame
 *                               // move-and-click cannot slip through a web
 *                               // that was never clickable at all.
 *            svg: '<svg…>' },   // the web; .yc-obj-break lands on it when it
 *                               // breaks (style the snap). Never spawns
 *                               // where its rect touches an input, select,
 *                               // textarea, or the focused element.
 *     trail: { every: 10,       // optional: px of travel between droppings
 *              life: 6,         // s before one is gone — the engine fades it
 *                               // out over the last stretch of that
 *              max: 40,         // hard cap; the oldest goes first
 *              svg: '<svg…>' }, // one dropping (offset it with css on
 *                               // .yc-obj-trail). Left while walking,
 *                               // chasing, climbing or hanging. World
 *                               // objects NEVER take pointer events — that
 *                               // is the engine's rule (.yc-obj), not the
 *                               // skin's choice, and it is what keeps every
 *                               // decoration unable to swallow a click.
 *     lines: [ … ],             // what it says when poked. House rules: short
 *                               // enough for a 250px bubble, in the animal's
 *                               // voice, never anything real — no counts, no
 *                               // deadlines, no names. A bubble that could be
 *                               // mistaken for a notification is the one way
 *                               // this stops being funny on someone's screen.
 *     words: { fly:'balloon' }, // the skin's PROSE for engine action names —
 *                               // display only, read by the trick panel
 *     svg:  '<svg …>',          // or function (CFG) returning one, called at
 *                               // build time (that is how a menorah would
 *                               // light one more candle per night). Its
 *                               // neutral, un-animated pose doubles as the
 *                               // picker portrait — design it standing.
 *     css:  [ … ]               // or function (CFG) returning the array. Rules
 *                               // for every state in `can` and every act in
 *                               // `acts`; may also override the engine's
 *                               // bubble/dark-mode base rules, since it is
 *                               // appended after them.
 *   });
 *
 *   THE RULE THAT MAKES SKINS CHEAP: state names stay ENGINE-owned. `inflate`/
 *   `float`/`pop` are the engine's three ascent phases whether the art is a
 *   balloon, a jetpack, a wing-flap or a tractor beam — a skin styles those
 *   names and renames them in `words` for display only. Renaming them in code
 *   is what turned the last robot into a fork.
 *
 * ── SKIN SELECTION ───────────────────────────────────────────────────────────
 *   The manifest below lists what the picker offers; the skin files stay
 *   unloaded until one is summoned or picked (so this stays one <script> tag,
 *   and the picker renders before anything downloads). TWO localStorage keys,
 *   deliberately not one:
 *     yc.mascot.on    '1' / '0' / absent — out, sent away, never decided
 *     yc.mascot.skin  {"id":"casey","at":<ms>} — which pet, and when chosen
 *                     (`at` is for the seasonal resolver, which arrives with
 *                     the seasonal skins: a choice made during a holiday
 *                     window beats the holiday, per-window)
 *   On/off is orthogonal to which pet: switching skins must not resurrect a
 *   mascot somebody sent away. A stored id that no longer exists, or a skin
 *   file that fails to load, falls back to the default skin for the session
 *   without overwriting the stored choice. Older builds left `yc.mascot.met`
 *   and `yc.mascot2.on` behind in some browsers; nothing reads either.
 *
 *   SEASONS sit on top of that (the SEASONAL table below): a window can force
 *   a form — the menorah, one candle more per night — or force a quiet
 *   absence on the solemn days (id: null). The user always wins per-window:
 *   picking a skin during a window, or explicitly summoning through a
 *   sit-out, overrides that window and only that window. Mascot.season()
 *   explains today's verdict from the console.
 *
 * HOW YOU GET IT
 *   The Casey tile in More (a second press opens the trick panel; its
 *   "Change form…" button opens the form picker), or a long-press of the
 *   header logo for ~0.9s.
 *   Either one puts it away again. So does double-clicking the animal, or
 *   Mascot.off() from the console. The choice is remembered per browser in
 *   localStorage. OFF by default for everyone — a colleague who never presses
 *   the tile never sees a cat.
 *
 * DRIVING IT FROM THE CONSOLE
 *   Mascot.talk()      — one of its lines, the same thing a poke gets you
 *   Mascot.list()      — every action it can be told to do, and what each needs
 *                        (list(true) returns the names without printing — the
 *                        trick panel builds itself from that, so an action
 *                        added here or in a skin turns up in it on its own)
 *   Mascot.fly()       — …or .jump() .climb() .sleep() .hang() etc, one per
 *                        action; the idle set is the skin's, so the robot
 *                        answers to .standby() and the cat to .sleep()
 *   Mascot.do(name)    — the same thing by name; Mascot.do() rolls a random one
 *   Mascot.skins()     — the picker's list; Mascot.skin() the one that is on
 *   Mascot.setSkin(id) — switch (tears down, lazy-loads, drops the new one in)
 *   Mascot.season(d?)  — today's (or any date's) seasonal verdict, and why
 *   Mascot.register(d) — a skin pasted straight into the console works too:
 *                        register it, then Mascot.setSkin(its id)
 *   Mascot.debug()     — outlines the box the mascot thinks it lives in
 *   Nothing else in the file calls these: they exist so the thing can be poked
 *   at without waiting twenty minutes for it to feel like doing the trick.
 *
 * WHY IT CANNOT BITE YOU
 *   - z-index 900: above shell chrome (≤100), below the versionGuard bar (999)
 *     and below SweetAlert2 (1060), so a modal always covers it. It also
 *     freezes while one is open — a toast excepted, that being a corner and not
 *     a modal. Skins cannot tune Z.
 *   - The container is pointer-events:none; only the sprite itself takes
 *     pointer events, so it can never swallow a click meant for the app.
 *   - Paused when the tab is hidden, and while the viewport is too narrow.
 *   - Respects prefers-reduced-motion by not existing at all.
 *   - No analytics, nothing written but the two localStorage keys; the only
 *     network is the same-origin skin file, fetched like any other script.
 *   - Loaded only by the staff shell. The portal, booking, e-sign and form
 *     pages never see this file, so nothing client-facing can ever show a cat.
 */
(function () {
  'use strict';

  // ── Config ───────────────────────────────────────────────────────────────────
  // Every engine tunable lives here; a skin's `tune` overrides by key and its
  // `geom` supplies W/H/FLY_HEAD. The speeds are deliberately slow: a pet that
  // hurries reads as a bug, a pet that ambles reads as a pet. These defaults
  // are Casey's numbers, because Casey is the reference skin.
  var BASE = {
    GRAVITY: 1500,         // px/s²
    TERMINAL: 900,         // px/s
    WALK: 46,              // px/s
    CLIMB: 55,             // cats go up faster than they saunter

    HANGSPEED: 30,
    CHASE: 92,
    HOLD_MS: 900,          // long-press duration on the logo
    Z: 900,
    MIN_VW: 900,           // below this the shell is in mobile layout — no pet
    RESCAN_MS: 1200,       // platform rescan throttle
    MAX_PLATFORMS: 40,

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

    // THE ASCENT — Casey's balloon, the robot's jetpack, whatever the skin
    // paints over `inflate`/`float`/`pop`. The only thing in here a cat cannot
    // actually do, which is exactly why it has to stay rare: seen twice it is a
    // delight, seen every minute it is a physics engine with a bug in it. The
    // rarity is carried by the COOLDOWN, not the roll — the roll only stops it
    // being clockwork — and it is decided when the pet settles down, so it
    // reads as a cat with an idea rather than a cat interrupted mid-stride.
    //
    // It rises CLEAR of a real ledge overhead — feet POP_CLEAR above the
    // surface, not below it — and ends there. Getting that the wrong way round
    // is the one mistake this whole thing can make: pop under the ledge and the
    // cat drops away from the very thing it spent six seconds floating up to.
    // Pop above it and the ordinary fall code lands it on top, exactly the way
    // a drop does. No new landing path, no new special case.
    FLY_CHANCE: 0.15,      // per settle-down, once the cooldown is up
    FLY_COOLDOWN: 240,     // s from one ascent to the next being possible
    FLY_FIRST: 45,         // …and none at all in the first seconds after it arrives
    FLY_GAP_MIN: 90,       // less overhead than this and it may as well have hopped
    // How FAR up it will go is really a question of how LONG the float lasts, so
    // that is the number kept here and the reach falls out of it. A flat pixel
    // cap was the second reason the top ledge was unreachable: from the floor of
    // a 900px window the header strip is ~844px up, and any cap tight enough to
    // feel safe cut it off. Crossing the whole page is the trick, not a bug.
    FLY_MAX_SECS: 11,      // longest a float may last, at FLY_MAX_VY
    POP_CLEAR: 46,         // px above the target the feet reach before it ends

    // …except over the TOPMOST ledge, the strip under the header, where there
    // is not 46px of anything to rise into. The skin's crown is FLY_HEAD above
    // the feet, so landing up there means the crown spends its last second in
    // the header — which is allowed and always was: the sprite is painted at
    // z-index 900, above shell chrome. The real ceiling is the WINDOW, not the
    // content box, and measuring against the content box was what made the top
    // ledge unreachable: every candidate failed a test it could never pass.
    //
    // So the clearance is whatever is left before the crown reaches y 0, and
    // the ascent ending against the top of the window is the nicer beat anyway.
    //
    // POP_MIN is 0 because the number it used to hold was a trap. The only
    // ledge that can ever score under 3 is this one: everything collectTops()
    // returns is floored at `view.top + 8`, so every ledge in the open page
    // clears 8 or more, and the floor clears the full POP_CLEAR. A non-zero
    // POP_MIN gated exactly one ledge, and gated it on the header height — at
    // --header-h 56px the top ledge scored 4 and passed, at 52 it scored 0 and
    // quietly stopped being a target, which is the failure this comment used to
    // predict. Zero keeps the test that still matters: a clearance below zero
    // means the crown would be pushed out of the top of the window, and that is
    // still rejected.
    POP_MIN: 0,            // least clearance still worth calling a landing
    FLY_LIFT: 150,         // px/s² the ascent pulls with, so it takes up the slack
    FLY_MAX_VY: 95,        // px/s ceiling on the rise. A balloon is not a rocket.
    FLY_SWAY: 9,           // px of side-to-side drift, about the launch column
    INFLATE_MS: 0.95,      // wind-up: the balloon filling / the turbine spooling
    POP_MS: 0.22,          // the ending, before it starts falling

    // THE NOCLIP PAIR — drift (gravity-off wander) and blink (the teleport).
    // Off for everything earthbound: a skin opts in by listing both in `can`
    // AND tuning DRIFT_CHANCE up. BLINK_MS is the whole fade-out — the skin's
    // css owns what the fade looks like; the engine only owns when the sprite
    // is somewhere else.
    DRIFT_CHANCE: 0,       // per settle-down, like FLY_CHANCE
    BLINK_MS: 0.5          // s gone between fading out and turning up elsewhere
  };

  // Storage and loading are engine constants, not tunables — a skin must not be
  // able to move them (see mergeCfgFor, which only lets `tune` touch BASE keys).
  var KEY = 'yc.mascot.on';            // matches the yc.* convention in scripts.js
  var SKIN_KEY = 'yc.mascot.skin';
  var SKIN_PATH = '/js/mascot/skins/';
  var DEFAULT_ID = 'casey';

  // Every state the engine can set — the vocabulary skins style against.
  // setState() is the only writer of dataset.state, so this list and the
  // setState call sites are held equal by the smoke test. drift and blink are
  // the noclip pair (a ghost's wander and teleport) — entered only by skins
  // that list them in `can` and tune DRIFT_CHANCE above zero.
  var STATES = ['walk', 'idle', 'chase', 'climb', 'hang', 'fall', 'hop',
    'crouch', 'land', 'drag', 'inflate', 'float', 'pop', 'drift', 'blink', 'leave'];

  // ── The manifest ─────────────────────────────────────────────────────────────
  // What the picker offers, renderable before any skin file downloads. `hidden`
  // (when it arrives with the seasonal skins) keeps an entry out of the picker;
  // `rowdy` will mark the obtrusive ones. The default skin leads the list.
  var MANIFEST = [
    { id: 'casey', name: 'Casey', blurb: 'A ginger cat. Walks the ledges, naps on your case list.' },
    { id: 'casey95', name: 'Casey-95', blurb: 'A Win95 robot cat. The same moves in button-grey plate — and a jetpack.' },
    { id: 'roomba', name: 'Roomba', blurb: 'A robot vacuum. Keeps to the floor — the ledges are safe, the crumbs are not.' },
    { id: 'ghost', name: 'Ghost', blurb: 'A ghost. Ignores gravity, respects the modals.' },
    { id: 'ufo', name: 'UFO', blurb: 'A flying saucer. Hovers, warps, abducts the odd cow.' },
    { id: 'snail', name: 'Snail', blurb: 'A snail. Unhurried, and it signs its work.' },
    // rowdy: the picker badges it and the blurb says so plainly — it is
    // opt-in, honestly labelled, and easy to kill, per §2.
    { id: 'spider', name: 'Spider', blurb: 'A spider. Spins webs where you work — one touch of the pointer breaks them. Rowdy.', rowdy: true },
    // hidden: real, but never in the picker — reachable only by being
    // seasonally forced, or from the console. The menorah must not be
    // pickable in July.
    { id: 'menorah', name: 'Menorah', blurb: 'Eight nights of lights. Turns up when it is time.', hidden: true }
  ];

  // ── The seasonal table ───────────────────────────────────────────────────────
  // Windows that FORCE a form (or a quiet absence — id: null) unless the user
  // changed skin during that same window; resolveSkin() holds the precedence.
  // `from` is 'MM-DD' (local civil date) or 'hebrew:<day> <Month>' with the
  // month spelled EXACTLY as Intl's en-u-ca-hebrew calendar spells it —
  // 'Tishri', not 'Tishrei'; 'Adar II' in leap years. (Spellings verified in
  // V8, 2026-09-15; Safari/Firefox spot-check pending. An unmatched spelling
  // fails SOFT: the window simply never fires.)
  // A window naming a skin that is not registered or listed also fails soft.
  // Holiday entries are added WITH their skins — the UFO gets July 4th when
  // the UFO exists.
  var SEASONAL = [
    // The solemn days. A playful mascot is tonally wrong on a fast day, so
    // the pet sits these out: it does not auto-appear, and no dialog explains
    // why — a quiet absence reads as respect, a cartoon does not. Someone who
    // EXPLICITLY summons it that day has made their own call: that summon
    // works, and counts as the day's override (see summon()).
    { id: null, from: 'hebrew:10 Tishri', days: 1 },     // Yom Kippur
    { id: null, from: 'hebrew:9 Av', days: 1 },          // Tisha B'Av
    // Hanukkah — the headline one: a candle per night via CFG.SEASONAL_DAY.
    { id: 'menorah', from: 'hebrew:25 Kislev', days: 8 }
  ];

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

  // ── Bail-outs, before anything is built ──────────────────────────────────────
  // Reduced motion is an accessibility request, not a preference: a creature
  // that wanders across the screen is exactly what it is asking us not to do.
  try {
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) { /* no matchMedia — carry on */ }

  // localStorage throws outright under some privacy modes; if we cannot remember
  // the user's choice we should not be starting anything.
  // THREE states, not two. "Never decided" has to be distinguishable from "sent
  // it away" — '0' means "this person said no" rather than "never asked".
  //   null → no opinion yet   '1' → asked for it   '0' → sent it away
  var store = (function () {
    try {
      localStorage.getItem(KEY);
      return {
        pref: function () { try { return localStorage.getItem(KEY); } catch (e) { return '0'; } },
        get: function () { return store.pref() === '1'; },
        set: function (v) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { } }
      };
    } catch (e) { return null; }
  })();
  if (!store) return;

  // The second key: which pet. Malformed or missing reads as "never chose".
  var skinStore = {
    get: function () {
      try {
        var v = JSON.parse(localStorage.getItem(SKIN_KEY) || 'null');
        return v && typeof v.id === 'string' ? v : null;
      } catch (e) { return null; }
    },
    set: function (id) {
      // `at` is load-bearing for the seasonal resolver (compared against each
      // seasonal window's own start, so an override is sticky per window).
      try { localStorage.setItem(SKIN_KEY, JSON.stringify({ id: id, at: Date.now() })); } catch (e) { }
    }
  };

  // ── State ────────────────────────────────────────────────────────────────────
  var REG = {};              // id → registered skin def
  var skin = null;           // the ACTIVE def (null until one is applied)
  var curId = DEFAULT_ID;    // the resolved skin id, applied or not
  var CFG = mergeCfgFor(null);   // engine defaults until a skin is applied

  var root = null, cat = null, styleEl = null;   // DOM
  var raf = 0, last = 0, running = false;

  var px = 0, py = 0;        // anchor = the pet's feet, centre of its foot line
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
  var fly = null;              // the ascent in progress: { popY, x0, t0 }
  var flyReady = 0;            // clock time the next ascent becomes possible
  var driftSeed = 0;           // phase offset so no two drifts trace one path
  var say = null;              // the speech bubble
  var sayTimer = 0;            // its expiry, held so a new line can reset it
  var lastLine = -1;           // so it does not say the same thing twice running
  var leaveRecords = true;     // does walking off count as "sent away"?

  var objs = [];               // world objects (trail droppings, one day webs)
  var lastTrail = { x: -1e9, y: -1e9 };

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
  // throttle, and the pet re-finds its footing afterwards (see refoot).
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
      wireFrameMouse(f);
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

  // The pointer tracker is frame-blind by default: events inside the content
  // iframe never bubble to the parent document, so the cursor-chase — and the
  // §2a web break — went dark over the very page the pet walks on. This wires
  // the tracker into the open page's own document, coordinates translated by
  // the frame's offset, idempotently per document (a navigation makes a fresh
  // document, which simply gets wired on the next scan).
  function wireFrameMouse(f) {
    try {
      var doc = f.contentDocument;
      if (!doc || doc.__ycMouse) return;
      doc.__ycMouse = 1;
      var h = function (e) {
        try {
          var fb = f.getBoundingClientRect();
          mouse.x = fb.left + e.clientX;
          mouse.y = fb.top + e.clientY;
          mouse.t = clock;
        } catch (err) { }
      };
      doc.addEventListener('pointermove', h, { passive: true });
      doc.addEventListener('pointerdown', h, { passive: true });
    } catch (e) { }
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

  // After a rescan the pet's ledge object is stale. Find the equivalent one in
  // the new list; if the ground genuinely went away (the table scrolled off, the
  // tab changed) then it went away underneath the pet, and the pet falls.
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

  // The per-act options a skin may have attached as the third slot of an acts
  // entry — {face, dur, cmdDur}. This is where "a sleeping cat always faces
  // right, so the floating z's are never mirrored" went when 'sleep' stopped
  // being an engine-known name: the CAT knows sleeping is sided, the engine
  // only knows some acts are.
  function actOpt(name) {
    var a = (skin && skin.acts) || [];
    for (var i = 0; i < a.length; i++) if (a[i][0] === name) return a[i][2] || {};
    return {};
  }

  // The act the pet does when it notices you — after a poke, and when a chase
  // catches up. The engine needs ONE act it can ask for by itself, and 'look'
  // was that name hardcoded; a skin whose repertoire spells it differently
  // (the robot scans) says so with `lookAct`. The old fork missed this and its
  // robot froze blankly when poked — the smoke test now holds every skin to it.
  function attn() { return (skin && skin.lookAct) || 'look'; }

  // The capability mask. A skin without `can` may do everything; a skin with
  // one may only enter the states it lists. This is checked where a gated
  // state is ENTERED — tryFly/tryHop, the climb and hang branches, the chase
  // roll — so the ambient behaviour and the console pass through one gate.
  function allowed(s) { return !skin || !skin.can || skin.can.indexOf(s) !== -1; }

  function toWalk() {
    setState('walk');
    stateUntil = clock + rand(2.4, 7);
    nextHop = clock + rand(CFG.HOP_EVERY[0], CFG.HOP_EVERY[1]);
  }

  function toIdle() {
    // The ascent is decided HERE, at the moment the pet stops walking, because
    // a cat that has just settled is the one with time to have an idea. Rolling
    // it on a timer instead meant the timer usually elapsed mid-walk and the
    // chance was silently thrown away, which makes the real frequency a fiction.
    if (clock >= flyReady && Math.random() < CFG.FLY_CHANCE && tryFly(false)) return;
    // The noclip skins lift off instead — the same settle-moment decision.
    if (allowed('drift') && Math.random() < CFG.DRIFT_CHANCE) { toDrift(); return; }
    setState('idle', pick(skin.acts));
    var o = actOpt(act);
    if (o.face) face = o.face;
    var d = o.dur || [1.8, 4.5];
    stateUntil = clock + rand(d[0], d[1]);
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
  // committed, in which case the pet is now crouching to jump.
  //
  // Only the landing SPOT is solved for, not the path: nothing checks whether
  // the arc clips a ledge on the way. It cannot go wrong, because the ledge it
  // clipped is one it can stand on, and landing early on the way to a lower
  // perch is just a cat changing its mind.
  function tryHop(dirX) {
    if (!allowed('hop')) return false;
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
    // then so a pet interrupted mid-wind-up is still standing on something.
    hop = { vx: need, vy: -CFG.HOP_LIFT, floor: py + 10 };
    aim(need >= 0 ? 1 : -1, 0);
    setState('crouch');
    stateUntil = clock + CFG.HOP_CROUCH;
    return true;
  }

  // Is there anything overhead worth an ascent? The mirror of tryHop, except the
  // pet has to end up OVER the target rather than beside it, which sets all three
  // of these tests:
  //   · the rise is a straight column, so the ledge must still be under the pet
  //     after the sway — hence the pad on each end;
  //   · it ends at POP_CLEAR ABOVE the surface, so the fall that follows lands
  //     on top of it. Popping below would drop the pet back the way it came;
  //   · and it needs headroom for that: a ledge so near the top of the page that
  //     clearing it would push the crown out of the content box is no good.
  //
  // `force` is the console's Mascot.fly(): a person who asked for an ascent gets
  // one even with nothing above, and it carries the pet to the top of the page
  // and ends there. The ambient roll never does that — an idle cat that floats
  // to the top and falls all the way back down has done a trick with no payoff
  // at the end of it.
  function tryFly(force) {
    if (!allowed('float')) return false;
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
      // before the ascent runs out of window — a few px, but a few px above the
      // surface is all a landing needs.
      var clear = Math.min(CFG.POP_CLEAR, l.y - roof);
      if (clear < CFG.POP_MIN) continue;
      cands.push({ y: l.y, clear: clear });
    }
    if (!cands.length && !force) return false;

    // Pick at RANDOM, not nearest. tryHop takes the nearest thing below because a
    // fall stops at the first surface whatever it aimed at; an ascent has no such
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
    // pet interrupted halfway through inflating is still standing on something.
    setState('inflate');
    stateUntil = clock + CFG.INFLATE_MS;
    return true;
  }

  function toPop() {
    vy = 0;
    setState('pop');
    stateUntil = clock + CFG.POP_MS;
  }

  // ── The noclip pair ──────────────────────────────────────────────────────────
  // Drift is wander with gravity off — a ghost does not stand ON things so
  // much as near them; blink is the teleport: fade out (the skin's css owns
  // the fade), be elsewhere, fade back in. Both end in ordinary states, so
  // everything else — the drag, the leave, the freeze under modals — works on
  // a noclip skin unchanged.
  function toDrift() {
    ledge = null; wall = null; rot = 0;
    hop = null; hopFloor = -1e9; fly = null;
    driftSeed = Math.random() * 100;
    vx = rand(-12, 12); vy = rand(-8, 8);
    setState('drift');
    stateUntil = clock + rand(4, 9);
  }

  function toBlink() {
    ledge = null; wall = null; rot = 0;
    hop = null; hopFloor = -1e9; fly = null;
    vx = 0; vy = 0;
    setState('blink');
    stateUntil = clock + CFG.BLINK_MS;
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

  // What happens when a walking pet runs out of ledge.
  function atEdge(dirX) {
    px = dirX > 0 ? ledge.x2 - 1 : ledge.x1 + 1;
    var w = wallNear(px, py);
    var roll = Math.random();
    if (w && allowed('climb') && roll < 0.42) { toClimb(w, true); return; }   // up the wall
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

    if (state === 'drag') return;      // the pointer owns the pet

    if (state === 'leave') {
      px += face * CFG.CHASE * dt;
      if (px < bounds.left - 50 || px > bounds.right + 50) {
        var rec = leaveRecords;
        stop();
        // Only a person sending it away is a decision. A programmatic leave —
        // toLeave(false), the way a seasonal sit-out will go out one day —
        // must keep "no opinion yet" intact, so anyone who liked it can still
        // summon it afterwards.
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
      // launched from — without this the pet lands right back where it started.
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
    // a floating pet sharing it would be a cat with a balloon falling anyway.
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
      // is sized to absorb exactly that. Make it bigger and the pet starts
      // missing the ledge it just spent six seconds floating up to.
      if (clock >= stateUntil) toFall(rand(-16, 16), 15);
      return;
    }

    if (state === 'drift') {
      // A slow figure-of-nothing: velocity eases toward a wandering target,
      // so the path curves instead of jittering. No gravity in here — this
      // branch sits above fall/hop for the same reason float does.
      var ease = Math.min(1, dt * 1.2);
      vx += (Math.sin(clock * 0.8 + driftSeed) * 16 - vx) * ease;
      vy += (Math.cos(clock * 0.53 + driftSeed * 2) * 11 - vy) * ease;
      px = clamp(px + vx * dt, bounds.left + 10, bounds.right - 10);
      py = clamp(py + vy * dt, bounds.top + 16, bounds.bottom - 4);
      aim(vx, 0);
      if (clock >= stateUntil) {
        if (allowed('blink') && Math.random() < 0.4) { toBlink(); return; }
        // …or sink back to the world: an ordinary fall, which for a skin this
        // floaty (they tune GRAVITY down) is a feather drop onto whatever is
        // below. That reuses the whole landing path, same trick as the pop.
        toFall(vx * 0.4, 0);
      }
      return;
    }

    if (state === 'blink') {
      if (clock < stateUntil) return;      // mid-fade — the css owns the look
      // Reappear somewhere else: usually a random spot, sometimes right by
      // the cursor, which is the better joke.
      var nearMouse = mouse.x > 0 && clock - mouse.t < 5 && Math.random() < 0.4;
      px = nearMouse ? clamp(mouse.x + rand(-30, 30), bounds.left + 10, bounds.right - 10)
        : rand(bounds.left + 20, bounds.right - 20);
      py = nearMouse ? clamp(mouse.y - rand(10, 40), bounds.top + 16, bounds.bottom - 10)
        : rand(bounds.top + 20, bounds.bottom - 30);
      toDrift();
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
      // pet just stepped off — which is how it ended up here.
      if (up && py <= w.y1 + 1) {
        py = w.y1 + 1;
        if (w.ceil && allowed('hang')) {
          // The strip under the header is a real surface, and this is the only
          // route to it once the pet has left the one it drops onto at start().
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
        if (wcl && allowed('climb')) toClimb(wcl, false); else face = -face;
        return;
      }
      if (clock >= stateUntil) {
        if (Math.random() < 0.55) toFall(rand(-30, 30), 0);
        else { face = -face; stateUntil = clock + rand(2, 5); }
      }
      return;
    }

    if (state === 'idle') {
      if (clock >= stateUntil) {
        if (skin.web) maybeWeb();      // a web is what a finished sit leaves
        toWalk();
      }
      return;
    }

    if (state === 'chase') {
      var want = clamp(mouse.x, ledge ? ledge.x1 + 4 : 4, ledge ? ledge.x2 - 4 : W - 4);
      var d = want - px;
      aim(d, 0);
      px += (d > 0 ? 1 : -1) * CFG.CHASE * dt;
      if (Math.abs(d) < 8 || clock >= stateUntil) {
        setState('idle', attn());                // caught up to it, now play dumb
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
      if (fresh && allowed('chase') && Math.random() < 0.3) { setState('chase'); stateUntil = clock + 4; }
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
    // 'fly' and watching a still cat next to the button that asked for it.
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
      // 'float' and 'pop' are airborne like fall/hop and must NOT be here; they
      // hold a bare y, not a ledge, precisely because ledges go stale on rescan.
      if (state === 'walk' || state === 'idle' || state === 'chase' ||
        state === 'land' || state === 'crouch' || state === 'inflate') refoot();
    }

    update(dt);
    // 'leave' tears everything down from inside update(), so the pet may be gone.
    if (!running || !cat) return;
    draw();
    if (skin.trail) maybeTrail();
    if (skin.web) breakWebs();
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
      // pick-up, and the pet should stay put for it — otherwise the second click
      // of a dismissal has to hit a cat that is already falling away.
      grab = {
        id: e.pointerId, x: e.clientX, y: e.clientY, t: now, t0: now,
        ox: e.clientX, oy: e.clientY,          // where the POINTER went down
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
      // Measured from where the POINTER started, not from px0/py0 — those are the
      // PET's feet, and you grab a cat by its body. Against the feet anchor the
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
      cat.classList.remove('yc-grabbed');
      // A poke: put it back where it was and let it notice you.
      if (!g.moved && performance.now() - g.t0 < 350) {
        px = g.px0; py = g.py0; rot = 0;
        ledge = g.ledge0;
        if (ledge) { setState('idle', attn()); stateUntil = clock + rand(1.2, 2.5); }
        else if (allowed('drift')) toDrift();  // a poked ghost hangs in the air
        else toFall(0, 0);
        talk();                 // after the pose, so the bubble is placed against it
        return;
      }
      toFall(clamp(g.vx * 0.35, -520, 520), clamp(g.vy * 0.35, -520, 520));
    }
    cat.addEventListener('pointerup', release);
    cat.addEventListener('pointercancel', release);
  }

  // ── World objects ────────────────────────────────────────────────────────────
  // Things the pet leaves behind in the world: a snail's trail today, webs one
  // day. They live inside #yc-mascot (so teardown takes them for free), they
  // are positioned in the same viewport space as the pet (they do not follow a
  // scrolling page — a fading decoration does not need to), and the engine —
  // not the skin — owns three things about them: the pointer-events:none that
  // keeps any decoration from ever swallowing a click (the §2a rule), the cap,
  // and the fade-and-removal clock.
  function dropObj(kind, x, y, html, life, max, data) {
    if (!root) return;
    // Per-KIND cap: a trail budget and a web budget never eat each other.
    var count = 0, oldest = -1;
    for (var i = 0; i < objs.length; i++) {
      if (objs[i].kind !== kind) continue;
      count++;
      if (oldest === -1) oldest = i;
    }
    if (count >= max) removeObj(oldest);
    var el = document.createElement('div');
    el.className = 'yc-obj yc-obj-' + kind;
    el.innerHTML = html;
    el.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
    // The engine owns the fade: fully there for the first stretch of life,
    // gone by the end. Armed a frame late so the transition actually runs.
    el.style.opacity = '1';
    el.style.transition = 'opacity ' + (life * 0.4).toFixed(1) + 's ease ' + (life * 0.6).toFixed(1) + 's';
    root.appendChild(el);
    requestAnimationFrame(function () { el.style.opacity = '0'; });
    var o = { el: el, kind: kind, data: data || null, breaking: false, timer: 0 };
    o.timer = setTimeout(function () {
      var i2 = objs.indexOf(o);
      if (i2 !== -1) removeObj(i2);
    }, life * 1000);
    objs.push(o);
  }

  function removeObj(i) {
    var o = objs[i];
    if (!o) return;
    clearTimeout(o.timer);
    o.el.remove();
    objs.splice(i, 1);
  }

  function clearObjs() { while (objs.length) removeObj(0); }

  // The trail: every `every` px of travel in a grounded state, one dropping
  // at the feet. Distance-gated rather than time-gated, so a pet that stops
  // stops leaving them.
  function maybeTrail() {
    var t = skin.trail;
    if (state !== 'walk' && state !== 'chase' && state !== 'climb' && state !== 'hang') return;
    var dx = px - lastTrail.x, dy = py - lastTrail.y;
    if (dx * dx + dy * dy < t.every * t.every) return;
    lastTrail.x = px; lastTrail.y = py;
    dropObj('trail', px, py, t.svg, t.life, t.max);
  }

  // A web never lands where someone is working: its rect must not touch an
  // input, select, textarea, or whatever holds focus — in the shell OR the
  // open page. Layout-dependent, so this is a browsers-only guard (jsdom has
  // no layout); the smoke test pins its presence in the source instead.
  function webTouchesField(x1, y1, x2, y2) {
    function hits(doc, ox, oy) {
      try {
        var els = doc.querySelectorAll('input, select, textarea');
        var list = [], k;
        for (k = 0; k < els.length && k < 120; k++) list.push(els[k]);
        if (doc.activeElement && doc.activeElement !== doc.body) list.push(doc.activeElement);
        for (k = 0; k < list.length; k++) {
          var r = list[k].getBoundingClientRect();
          if (!r.width && !r.height) continue;
          if (x1 < ox + r.right && x2 > ox + r.left && y1 < oy + r.bottom && y2 > oy + r.top) return true;
        }
      } catch (e) { }
      return false;
    }
    if (hits(document, 0, 0)) return true;
    var f = contentFrame();
    if (f) {
      try {
        var fb = f.getBoundingClientRect();
        if (f.contentDocument && hits(f.contentDocument, fb.left, fb.top)) return true;
      } catch (e) { }
    }
    return false;
  }

  // A web is what a finished sit leaves behind — rolled when an idle period
  // ends, optionally only after the skin's named spinning act.
  function maybeWeb() {
    var w = skin.web;
    if (!w || !ledge) return;
    if (w.act && act !== w.act) return;
    if (Math.random() >= w.chance) return;
    if (webTouchesField(px - w.w / 2, py - w.h, px + w.w / 2, py)) return;
    dropObj('web', px, py, typeof w.svg === 'function' ? w.svg(CFG) : w.svg, w.life, w.max,
      { cx: px, cy: py - w.h / 2, breakR: w.breakR });
  }

  // §2a's enforcement, all of it: a web breaks when the POINTER comes near —
  // a distance test against the tracked cursor, run each frame over at most
  // `max` webs. No web ever has pointer events, so there is no click to
  // swallow; a touch tap breaks on first contact because pointerdown feeds
  // the same tracker; and a fast move-and-click inside one frame cannot slip
  // through a thing that was never clickable.
  function breakWebs() {
    if (mouse.x < 0) return;
    for (var i = objs.length - 1; i >= 0; i--) {
      var o = objs[i];
      if (o.kind !== 'web' || o.breaking || !o.data) continue;
      var dx = mouse.x - o.data.cx, dy = mouse.y - o.data.cy;
      if (dx * dx + dy * dy > o.data.breakR * o.data.breakR) continue;
      o.breaking = true;
      clearTimeout(o.timer);
      o.el.classList.add('yc-obj-break');
      (function (ob) {
        ob.timer = setTimeout(function () {
          var j = objs.indexOf(ob);
          if (j !== -1) removeObj(j);
        }, 450);
      })(o);
    }
  }

  // ── The bubble ───────────────────────────────────────────────────────────────
  // ONE bubble, reused by everything the pet says when poked. Holding the timer
  // is the whole reason this is not two functions: a line that replaces another
  // has to take the clock with it, or the first line's expiry cuts the second
  // one short a moment after it appears.
  function speak(text, secs) {
    if (!root) return;
    if (!say) {
      say = document.createElement('div');
      say.className = 'yc-say';
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
    var LINES = skin.lines;
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

  // ── Build / teardown ─────────────────────────────────────────────────────────
  // The engine's own stylesheet: the container, the sprite box, the bubble, the
  // logo charge. Everything else — poses, gaits, the whole look — is the skin's
  // css, appended after this so a skin may also override these (Casey-95 squares
  // off the bubble, because what it is quoting is a system dialog).
  function engineCss() {
    return [
      '#yc-mascot{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:' + CFG.Z + ';}',
      '@media print{#yc-mascot{display:none!important}}',
      '.yc-cat{position:absolute;left:0;top:0;width:' + CFG.W + 'px;height:' + CFG.H + 'px;',
      // LOAD-BEARING. draw() composes rotate/scaleX about the element's origin;
      // the CSS default of 50% 50% pivots about the sprite's centre instead and
      // throws the pet 32px off its anchor — invisibly at rot:0, but every climb
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
      // Dark mode is handled the way artwork should be — the sprite lifts under
      // a filter, not a repaint. A skin whose palette wants a different lift
      // overrides this line from its own css.
      'html[data-theme="dark"] .yc-cat{filter:drop-shadow(0 1px 2px rgba(0,0,0,.55)) brightness(1.08)}',
      '.yc-cat svg{display:block;overflow:visible}',
      '.yc-cat g,.yc-cat path,.yc-cat rect,.yc-cat circle,.yc-cat text{transform-box:view-box}',
      // World objects. The §2a rule made structural — and the wildcard with
      // !important is the load-bearing half: pointer-events INHERITS, so the
      // container's none already covers a plain child, but a child can
      // RE-ENABLE it (that is how .yc-cat takes clicks inside this very
      // container). The !important wildcard is what makes a decoration's
      // markup unable to do the same, even on purpose.
      '.yc-obj,.yc-obj *{pointer-events:none!important}',
      '.yc-obj{position:absolute;left:0;top:0;will-change:opacity}',
      '.yc-obj svg{display:block;overflow:visible}',
      /* the trigger: the logo visibly charges while you hold it */
      '.hdr-logo.yc-charging{transform:scale(.86);opacity:.6;',
      'transition:transform ' + CFG.HOLD_MS + 'ms ease-in,opacity ' + CFG.HOLD_MS + 'ms ease-in;}'
    ].join('\n');
  }

  function svgOf(d) { return typeof d.svg === 'function' ? d.svg(CFG) : d.svg; }
  function cssOf(d) { return (typeof d.css === 'function' ? d.css(CFG) : d.css).join('\n'); }

  function build() {
    styleEl = document.createElement('style');
    styleEl.id = 'yc-mascot-style';
    styleEl.textContent = engineCss() + '\n' + cssOf(skin);
    document.head.appendChild(styleEl);

    root = document.createElement('div');
    root.id = 'yc-mascot';

    cat = document.createElement('div');
    cat.className = 'yc-cat';
    cat.innerHTML = svgOf(skin);
    // Always Casey, whatever the form — identity is not the skin's to rename.
    cat.title = 'Casey · drag me · double-click to send me away';
    root.appendChild(cat);
    document.body.appendChild(root);

    wireCat();
  }

  function start() {
    if (running) return;
    if (!skin) return;                  // no skin applied — activate() first
    if (!document.body) return;
    if (vw() < CFG.MIN_VW) return;
    running = true;
    if (!root) build();
    scan();
    lastScan = performance.now();
    clock = 0;
    fly = null;
    flyReady = CFG.FLY_FIRST;      // it has to be here a while before it gets ideas
    lastTrail.x = -1e9; lastTrail.y = -1e9;
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
    // The bubble element dies with the container, so the handle to it has to
    // die too — speak() after a restart would otherwise write into a detached
    // node and the first poke of the new pet would say nothing.
    if (sayTimer) clearTimeout(sayTimer);
    say = null; sayTimer = 0;
    clearObjs();      // their elements die with root, but their timers do not
    if (root) { root.remove(); root = null; cat = null; }
    if (styleEl) { styleEl.remove(); styleEl = null; }
    grab = null;
  }

  // ── The skin registry ────────────────────────────────────────────────────────
  function findManifest(id) {
    for (var i = 0; i < MANIFEST.length; i++) if (MANIFEST[i].id === id) return MANIFEST[i];
    return null;
  }

  // A skin file's entry point. Console-pasted skins land here too — being in
  // the manifest is what gets a skin OFFERED, not what lets it run.
  function register(def) {
    var ok = def && typeof def.id === 'string' && /^[a-z0-9_-]+$/i.test(def.id) &&
      typeof def.name === 'string' &&
      def.geom && def.geom.W > 0 && def.geom.H > 0 && def.geom.FLY_HEAD >= 0 &&
      def.acts && def.acts.length && def.lines && def.lines.length &&
      def.svg && def.css;
    // A `can` mask has its own shape rules: the core six are not optional (a
    // pet that cannot fall or leave breaks the physics and the exit), a hop
    // needs its crouch, and the ascent is three states or none — half an
    // ascent is a pet that inflates and then teleports.
    if (ok && def.can) {
      var CORE = ['walk', 'idle', 'fall', 'land', 'drag', 'leave'];
      var has = function (s) { return def.can.indexOf(s) !== -1; };
      ok = def.can.length > 0;
      for (var c = 0; c < CORE.length && ok; c++) ok = has(CORE[c]);
      if (ok && has('hop') !== has('crouch')) ok = false;
      if (ok && (has('inflate') !== has('float') || has('float') !== has('pop'))) ok = false;
      if (ok && has('blink') && !has('drift')) ok = false;   // a blink lands in a drift
    }
    // A trail keeps its own promises: real spacing, a finite life, a cap.
    if (ok && def.trail) {
      ok = def.trail.every > 0 && def.trail.life > 0 && def.trail.max > 0 && !!def.trail.svg;
    }
    // …and a web keeps §2a's: real odds, a finite life, a cap, a break
    // radius, a rect for the spawn veto, and a spinning act that exists.
    if (ok && def.web) {
      var wb = def.web;
      ok = wb.chance > 0 && wb.chance <= 1 && wb.life > 0 && wb.max > 0 &&
        wb.breakR > 0 && wb.w > 0 && wb.h > 0 && !!wb.svg;
      if (ok && wb.act) {
        var found = false;
        for (var a2 = 0; a2 < def.acts.length; a2++) if (def.acts[a2][0] === wb.act) found = true;
        ok = found;
      }
    }
    if (!ok) {
      console.warn('[Mascot] register() refused a malformed skin', def && def.id);
      return false;
    }
    REG[def.id] = def;
    return true;
  }

  // BASE + the skin's tune + its geometry, as a fresh object so nothing a skin
  // tunes can leak into the next one. tune may only touch knobs BASE actually
  // has — a skin cannot invent keys, cannot reach the storage constants, and
  // cannot move Z: the z-order promise in the header is the engine's to keep.
  function mergeCfgFor(def) {
    var out = {}, k;
    for (k in BASE) out[k] = BASE[k];
    if (def) {
      var t = def.tune || {};
      for (k in t) if (k in out && k !== 'Z') out[k] = t[k];
      out.W = def.geom.W; out.H = def.geom.H; out.FLY_HEAD = def.geom.FLY_HEAD;
    } else {
      out.W = 36; out.H = 28; out.FLY_HEAD = 52;
    }
    out.SEASONAL_DAY = -1;       // applySkin() fills this for a forced skin
    return out;
  }

  // Fetch a skin file if its def is not already in hand. The <script> route
  // rather than fetch(): same-origin static, no CORS thought required, and the
  // file registers itself exactly the way a console paste does.
  var pendingLoads = {};
  function injectSkin(id, cb) {
    if (REG[id]) { cb(true); return; }
    if (!/^[a-z0-9_-]+$/i.test(String(id))) { cb(false); return; }
    if (pendingLoads[id]) { pendingLoads[id].push(cb); return; }
    pendingLoads[id] = [cb];
    var s = document.createElement('script');
    s.src = SKIN_PATH + id + '.js';
    function done() {
      var cbs = pendingLoads[id];
      delete pendingLoads[id];
      s.remove();
      var ok = !!REG[id];       // onload with no register() is still a failure
      for (var i = 0; i < cbs.length; i++) cbs[i](ok);
    }
    s.onload = done;
    s.onerror = done;
    document.head.appendChild(s);
  }

  // Make a loaded def the live one: merged config, rebuilt action table and
  // console shorthands, and a word to anyone listening (the More tile).
  function applySkin(id) {
    skin = REG[id];
    curId = id;
    CFG = mergeCfgFor(skin);
    // A seasonally-forced skin learns which day of its window this is — how
    // the menorah knows tonight's candle count. -1 otherwise, and a skin
    // summoned out of season shows its full-dress state (svg functions treat
    // -1 as "all of it": the portrait is the finale, not night one).
    var s = seasonNow(new Date());
    if (s && s.entry.id === id) CFG.SEASONAL_DAY = s.day;
    lastLine = -1;
    rebuildActions();
  }

  // Resolve → load (falling back to the default skin) → apply. The fallback
  // runs the session on the default WITHOUT overwriting the stored choice: a
  // deploy that dropped one skin file should not delete anyone's preference.
  function activate(id, cb) {
    injectSkin(id, function (ok) {
      if (!ok && id !== DEFAULT_ID) {
        console.warn('[Mascot] skin "' + id + '" did not load — falling back to ' + DEFAULT_ID);
        activate(DEFAULT_ID, cb);
        return;
      }
      if (!ok) { cb(false); return; }
      applySkin(id);
      cb(true);
    });
  }

  // ── Seasonal resolution ──────────────────────────────────────────────────────
  // Hebrew dates via Intl's built-in hebrew calendar — no dependency. Two
  // gotchas, both deliberate:
  //   · Hebrew days begin at SUNSET and Intl rolls at local midnight.
  //     Advancing the Hebrew date at 18:00 local is one line and closer to
  //     right. Do not "fix" this as a bug.
  //   · Kislev is 29 or 30 days depending on the year, so "night N" is never
  //     arithmetic on a day-of-month: seasonalDay() steps BACK a civil day at
  //     a time until it hits the window's first day (max `days` steps), which
  //     is always correct and needs no month-length table.
  var HEB_FMT = null;
  function hebrewDate(d) {
    try {
      if (!HEB_FMT) HEB_FMT = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long' });
      var parts = HEB_FMT.formatToParts(new Date(d.getTime() + 6 * 3600 * 1000));
      var out = {};
      for (var i = 0; i < parts.length; i++) out[parts[i].type] = parts[i].value;
      return out.day + ' ' + out.month;            // '25 Kislev' · '10 Tishri'
    } catch (e) { return ''; }     // no hebrew calendar → hebrew windows fail soft
  }

  function onFrom(w, d) {
    if (w.from.slice(0, 7) === 'hebrew:') return hebrewDate(d) === w.from.slice(7);
    var mm = d.getMonth() + 1, dd = d.getDate();
    return ((mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd) === w.from;
  }

  // Which day (0-based) of window `w` contains `now` — or -1.
  function seasonalDay(w, now) {
    for (var k = 0; k < w.days; k++) {
      if (onFrom(w, new Date(now.getTime() - k * 86400000))) return k;
    }
    return -1;
  }

  // The active window at `now`; first hit in table order wins.
  function seasonNow(now) {
    for (var i = 0; i < SEASONAL.length; i++) {
      var day = seasonalDay(SEASONAL[i], now);
      if (day !== -1) return { entry: SEASONAL[i], day: day };
    }
    return null;
  }

  // Did the user pick a skin DURING this window? Then the user wins — per
  // window, not forever: switching away from the menorah on night 2 does not
  // stop a future window from forcing. (The plan stated this as `at >=
  // window.from`; "`at` falls inside THIS instance of the window" is the same
  // rule without reconstructing a start timestamp across the 18:00 boundary —
  // the recency check pins it to this instance, with a day of slop for that
  // boundary, and last year's choice is months older than any window is long.)
  function overridden(s, rec, now) {
    if (!rec || !rec.at) return false;
    if (now.getTime() - rec.at > (s.entry.days + 1) * 86400000) return false;
    return seasonalDay(s.entry, new Date(rec.at)) !== -1;
  }

  function storedOr(rec) {
    var id = rec && rec.id;
    if (id && (REG[id] || findManifest(id))) return id;
    return DEFAULT_ID;
  }

  // The full verdict: which skin now, and why. `when` is for the console and
  // the tests; the boot path calls it with nothing.
  //   1. a seasonal window containing now, unless the user overrode it during
  //      this window;
  //   2. the stored skin id, if it still names something real;
  //   3. the default.
  function resolveSkin(when) {
    var now = when ? new Date(when) : new Date();
    var rec = skinStore.get();
    var s = seasonNow(now);
    if (s && !overridden(s, rec, now)) {
      if (s.entry.id === null) {
        // A sit-out day. The id is still resolved — it is what an explicit
        // summon (the user's override) brings out.
        return { id: storedOr(rec), sitOut: true, seasonal: s };
      }
      if (REG[s.entry.id] || findManifest(s.entry.id)) {
        return { id: s.entry.id, sitOut: false, seasonal: s };
      }
      // A window naming a skin that does not exist falls through to normal.
    }
    return { id: storedOr(rec), sitOut: false, seasonal: null };
  }

  function resolveSkinId() { return resolveSkin().id; }

  // One mascot on screen at a time: switching tears down and rebuilds, and the
  // new pet drops in from the top the way a summoned one does. The choice is
  // only persisted once the file has actually loaded.
  function setSkin(id, cb) {
    injectSkin(String(id), function (ok) {
      if (!ok) {
        console.warn('[Mascot] skin "' + id + '" failed to load');
        if (cb) cb(false);
        return;
      }
      skinStore.set(id);
      var wasOut = running;
      if (wasOut) stop();
      applySkin(id);
      if (wasOut) start();
      if (cb) cb(true);
    });
  }

  // What the shell knows about the current skin. Works before the skin file
  // loads (from the manifest), gets richer after (words).
  function skinInfo() {
    var m = findManifest(curId) || {};
    var d = REG[curId] || {};
    return {
      id: curId,
      name: d.name || m.name || curId,
      blurb: d.blurb || m.blurb || '',
      words: d.words || {}
    };
  }

  // The summon path shared by boot, the tile and the logo: resolve which pet,
  // load it if need be, start. The verdict callback is for the tile — with the
  // skin cached it answers synchronously, on first load it answers when the
  // file does. `explicit` marks a person asking right now (tile, logo,
  // Mascot.on()) as opposed to the boot path replaying a stored preference —
  // the difference only matters on a sit-out day.
  function summon(cb, explicit) {
    var r = resolveSkin();
    if (r.sitOut) {
      if (!explicit) return;               // the quiet absence — see SEASONAL
      // An explicit summon on a sit-out day is the user's call to make, and
      // it stamps the override so the rest of the day behaves normally.
      skinStore.set(r.id);
    }
    activate(r.id, function (ok) {
      if (!ok) { if (cb) cb('no-skin'); return; }
      start();
      if (cb) cb(running ? 'on' : 'narrow');
    });
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

  // `cb`, when given, hears how it went: 'off' · 'on' · 'narrow' (start()
  // declined below MIN_VW) · 'no-skin' (no skin file would load). The tile uses
  // it to answer instead of looking dead; the logo calls with nothing.
  function toggle(cb) {
    if (running) { toLeave(true); if (cb) cb('off'); return; }
    store.set(true);
    summon(cb, true);
  }

  // ── Console control ──────────────────────────────────────────────────────────
  // Nothing in the file calls any of this; it exists so the pet can be made to
  // do a thing on demand instead of waiting for it to feel like it — which for
  // the ascent is otherwise a four-minute wait per attempt.
  //
  // `run` returns nothing when the action took, or a STRING saying why it did
  // not. A console command that silently does nothing is worse than one that
  // says "no wall in reach" — you cannot tell a refusal from a broken build.
  var BASE_ACTIONS = [
    { name: 'walk', needs: 'ledge', what: 'set off along the ledge it is on', run: function () { toWalk(); } },
    { name: 'idle', needs: 'ledge', what: 'stop, and roll one of the idle acts', run: function () { toIdle(); } },
    { name: 'talk', needs: 'any', what: 'say one of its lines — the same thing a poke does', run: function () { talk(); } },
    {
      name: 'jump', needs: 'ledge', gate: 'hop', what: 'drop to a lower ledge — or hop on the spot if there is none',
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
      name: 'fly', needs: 'ledge', gate: 'float', what: 'the ascent. Ignores the cooldown, and tops out on the ceiling if nothing is overhead',
      run: function () { if (!tryFly(true)) return 'no room above it to rise'; }
    },
    {
      name: 'climb', needs: 'any', gate: 'climb', what: 'take the nearest wall and go up it',
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
      name: 'hang', needs: 'any', gate: 'hang', what: 'hang from the ceiling (cheats — it does not walk there)',
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
        // of y0, so a pet that lets go while standing ON a ledge finds that same
        // ledge on its first airborne frame and lands straight back on it. The
        // walking path never hits this because atEdge() steps off the end first.
        py += 2;
        toFall(rand(-40, 40), 30);
      }
    },
    {
      name: 'chase', needs: 'ledge', gate: 'chase', what: 'run at the cursor',
      run: function () {
        if (mouse.x < 0) return 'move the mouse first — it has not seen the cursor yet';
        setState('chase');
        stateUntil = clock + 4;
      }
    },
    {
      name: 'drift', needs: 'any', gate: 'drift', what: 'lift off and wander — gravity is a suggestion',
      run: function () { toDrift(); }
    },
    {
      name: 'blink', needs: 'any', gate: 'blink', what: 'vanish, and turn up somewhere else',
      run: function () { toBlink(); }
    },
    { name: 'flip', needs: 'any', what: 'turn around', run: function () { face = -face; } }
  ];

  var ACTIONS = BASE_ACTIONS.slice();
  var dynNames = [];      // the shorthand keys the ACTIVE skin put on window.Mascot

  // The action table is the base set plus one command per idle act, read
  // straight off the skin's acts so the two lists cannot drift apart — and
  // rebuilt on every skin switch, so the robot answers to .standby() and the
  // cat to .sleep(), never both.
  function rebuildActions() {
    ACTIONS = BASE_ACTIONS.slice();
    var i;
    for (i = 0; i < skin.acts.length; i++) {
      (function (a) {
        ACTIONS.push({
          name: a, needs: 'ledge', what: 'idle: ' + a,
          run: function () {
            setState('idle', a);
            var o = actOpt(a);
            if (o.face) face = o.face;
            var d = o.cmdDur || [3, 6];
            stateUntil = clock + rand(d[0], d[1]);
          }
        });
      })(skin.acts[i][0]);
    }
    // One shorthand per action — Mascot.fly(), Mascot.sleep(), Mascot.jump()…
    // The previous skin's shorthands go first, then this skin's come up. The
    // guard means an action can never quietly overwrite on/off/toggle/list/
    // debug/register/setSkin if a skin names an act after one of them.
    for (i = 0; i < dynNames.length; i++) delete window.Mascot[dynNames[i]];
    dynNames = [];
    for (i = 0; i < ACTIONS.length; i++) {
      (function (n) {
        if (window.Mascot[n]) return;
        window.Mascot[n] = function () { return doAction(n); };
        dynNames.push(n);
      })(ACTIONS[i].name);
    }
  }

  function findAction(n) {
    n = String(n == null ? '' : n).toLowerCase();
    for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i].name === n) return ACTIONS[i];
    return null;
  }

  // The actions this FORM can be asked for: the table minus anything whose
  // gate the skin's `can` shuts. list(), the panel it feeds, and the random
  // roll all draw from this, so a Roomba's panel simply has no fly button
  // rather than a fly button that apologises.
  function openActions() {
    var out = [];
    for (var i = 0; i < ACTIONS.length; i++) {
      if (ACTIONS[i].gate && !allowed(ACTIONS[i].gate)) continue;
      out.push(ACTIONS[i]);
    }
    return out;
  }

  function doAction(name) {
    if (!running || !cat) {
      console.warn('[Mascot] not out — Mascot.on(), or long-press the logo');
      return false;
    }
    if (name == null) {
      var open = openActions();
      name = open[Math.floor(Math.random() * open.length)].name;
    }
    var a = findAction(name);
    if (!a) { console.warn('[Mascot] no action "' + name + '" — try Mascot.list()'); return false; }
    if (a.gate && !allowed(a.gate)) {
      console.warn('[Mascot] ' + a.name + ' is not in this form\'s repertoire');
      return false;
    }
    // 'drag' and every airborne state have no ledge, so this one test covers all
    // the ways the pet can be in no position to oblige.
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
    on: function () { store.set(true); summon(null, true); },
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
      var rows = [], names = [], open = openActions();
      for (var i = 0; i < open.length; i++) {
        rows.push({ call: 'Mascot.' + open[i].name + '()', needs: open[i].needs, what: open[i].what });
        names.push(open[i].name);
      }
      if (quiet) return names;
      try { console.table(rows); } catch (e) { console.log(rows); }
      console.log('Mascot.do("name") runs one by name · Mascot.do() rolls a random one');
      return names;
    },

    // ── Skins ──
    register: register,
    // The picker's list: manifest order, hidden entries left out, the current
    // one flagged. Copies, so a caller cannot edit the manifest.
    skins: function () {
      var out = [];
      for (var i = 0; i < MANIFEST.length; i++) {
        var m = MANIFEST[i];
        if (m.hidden) continue;
        out.push({ id: m.id, name: m.name, blurb: m.blurb, rowdy: !!m.rowdy, current: m.id === curId });
      }
      return out;
    },
    skin: skinInfo,
    setSkin: setSkin,
    // Why is (or isn't) the pet what it is today: the seasonal verdict, for
    // now or for any date you hand it — Mascot.season('2026-12-05'). `day` in
    // the window is 1-based, the way a person counts nights.
    season: function (when) {
      var r = resolveSkin(when);
      var s = r.seasonal;
      return {
        id: r.id, sitOut: r.sitOut,
        window: s ? { id: s.entry.id, from: s.entry.from, days: s.entry.days, day: s.day + 1 } : null
      };
    },
    // The picker's portrait: the skin's own SVG in its neutral pose, which the
    // contract asks every skin to design standing. Loads the file if need be;
    // answers null if it will not come.
    portrait: function (id, cb) {
      injectSkin(String(id), function (ok) {
        if (!ok) { cb(null); return; }
        var d = REG[id];
        try { cb(typeof d.svg === 'function' ? d.svg(mergeCfgFor(d)) : d.svg); }
        catch (e) { cb(null); }
      });
    },
    STATES: STATES.slice(),

    // Console aid for "why is it standing THERE": outlines the content box the
    // pet believes it lives in for three seconds, and returns the numbers.
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
        skin: curId,
        bounds: bounds,
        cat: { state: state, x: Math.round(px), y: Math.round(py), rot: rot },
        // Seconds until an ascent is possible again. 0 means the only thing left
        // between you and one is the roll in toIdle() and something to fly to.
        flyIn: Math.max(0, Math.round(flyReady - clock)),
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

  function boot() {
    wireTrigger();
    // Resolve which form this browser gets before anything downloads, so
    // Mascot.skin() and skins() answer correctly before the first summon.
    curId = resolveSkinId();
    if (store.pref() === '1') summon();          // asked for it, last time
    // Wired once, at boot rather than per build(), so on/off cycles don't
    // stack up duplicate listeners. It feeds the cursor chase and the web
    // break; pointerdown too, so a touch tap counts as contact (§2a).
    var track = function (e) {
      mouse.x = e.clientX; mouse.y = e.clientY; mouse.t = clock;
    };
    document.addEventListener('pointermove', track, { passive: true });
    document.addEventListener('pointerdown', track, { passive: true });
    window.addEventListener('resize', function () { lastScan = -1e9; });
  }
  // NOTE: boot() is called at the very BOTTOM of this file, not here — the
  // pattern the old single file needed to keep its SVG and CSS defined before
  // boot ran. The tail data is gone but the pattern stays: it costs nothing,
  // and the next person to add something below boot() will not trip over it.

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
