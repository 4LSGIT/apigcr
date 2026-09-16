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
 *     blurb: 'Walks the ledges.',
 *                               // ONE picker line, shown under the name —
 *                               // so it need not repeat the name, and a
 *                               // rowdy form need not say 'rowdy' (the
 *                               // picker badges that itself). Say what it
 *                               // DOES; the card clamps at three lines.
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
 *     roam: true,               // TOP VIEW: the page is the floor. `walk`
 *                               // becomes a free 2D crawl anywhere in the
 *                               // content box (edges preferred, nothing
 *                               // required), a throw SLIDES and tumbles to a
 *                               // stop instead of falling, the sprite spawns
 *                               // in place and ROTATES to its heading —
 *                               // design the art facing +x. Required by the
 *                               // rappel and weave states.
 *     upright: true,            // roam variant: SIDE-PROFILE roaming (the
 *                               // desktop-goose stance). The sprite never
 *                               // rotates to heading — it stays upright and
 *                               // FLIPS to face its travel — and a throw
 *                               // slides to a stop without the tumble spin.
 *                               // Design the art facing +x. Needs roam.
 *     heist: { props: ['<svg…>', …],
              to: 'stash' },   // WHERE AN ERRAND ENDS, and the only real
                               // difference between a thief and a retriever.
                               // 'stash' (the default) is the pet's own
                               // corner hoard; 'cursor' brings the thing to
                               // YOU and drops it at your feet — re-aimed
                               // every frame, so moving the mouse changes its
                               // course mid-trot. A 'cursor' errand also goes
                               // for loot already on the floor before making
                               // anything new (a dog fetches the ball it has)
                               // and never takes words or icons off the page:
                               // fetching is not stealing.
 *                               // the thief's kit: with this, the form runs
 *                               // HEISTS (HEIST_CHANCE per settle-down, or
 *                               // the 'steal' command): it walks to a spot,
 *                               // takes something — one of these prop svgs,
 *                               // or a visual COPY of a word off the page
 *                               // (copy only, text only: built through
 *                               // textContent, so markup can never ride
 *                               // along and the page is never touched) —
 *                               // carries it in the beak (data-carry="1" on
 *                               // the pet while it does) and stashes it in
 *                               // its corner hoard as a 'loot' world object
 *                               // (engine-capped, engine-faded, never
 *                               // clickable like every .yc-obj). Needs roam.
 *     haunt: { max: 3,          // how much of the page may be crooked at once
              life: 12,        // s before a disturbed thing rights itself
              sel: 'button,.card',
                               // what counts as furniture worth leaning on
              poses: ['rotate(-3deg)', …] },
                               // TRANSFORMS ONLY, and small ones. Hit-testing
                               // follows a transform, so a tilted button is
                               // still clickable exactly where it now looks
                               // (§2: visual, never input) and nothing
                               // reflows around it. The engine applies one,
                               // adds .yc-haunted for the skin to animate,
                               // and undoes it through ONE door — a timer, a
                               // press on the thing, a grab, or send-away.
                               // Keep poses small: shoving an element over
                               // its neighbour would cover a control, which
                               // is the one thing this must never do.
     graffiti: { texts: ['BOO', …],
                                // what it writes. The LOUD prank: big, over
                                // your content, and unmissable — which is why
                                // it keeps every world-object promise (never
                                // clickable, capped, faded on a clock) and the
                                // undo this arc gives everything the pet does
                                // to your page: pressing it wipes it off
                                // (.yc-obj-wipe lands on it — animate the rub).
                 max: 3, life: 25,
                 svg: function (CFG, text, tilt, w, h) { … } },
                                // the engine picks the words, the spot and the
                                // angle; the skin owns the HAND it is written
                                // in. Needs no `can` entry — scrawling is not
                                // a state, it is something left behind.
     web: { ringS: 3.2,        // s per ring while weaving
 *            stages: 12,        // ring cap — growth stops, the tending never
 *                               // does: it builds until somebody breaks it
 *            life: 120,         // s an abandoned web lingers before fading
 *            max: 3,            // webs on screen; oldest goes first
 *            breakR0: 8, breakDr: 4.6,
 *                               // break radius: base + per-ring. §2a's whole
 *                               // implementation: the POINTER coming that
 *                               // close breaks it — a distance test against
 *                               // the cursor the engine already tracks, so a
 *                               // web never has pointer events, a touch tap
 *                               // breaks on first contact, and a same-frame
 *                               // move-and-click cannot slip through a web
 *                               // that was never clickable at all.
 *            svg: function (CFG, stage) { … } },
 *                               // the web at `stage` rings inside ONE fixed
 *                               // viewBox (growth happens within it, so the
 *                               // element never moves). Webs may grow over
 *                               // ANYTHING — reaching what one covers means
 *                               // moving the pointer there, which breaks it
 *                               // on the way in — so keep breakR0+breakDr
 *                               // covering the full visual radius. The one
 *                               // exception: a web overlapping the KEYBOARD-
 *                               // focused field breaks on its own, so a tab
 *                               // user is never typing under silk.
 *                               // .yc-obj-break lands on a broken web —
 *                               // style the snap.
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
 *   Mascot.rehearse(id, day?) — try any form, hidden ones included, without
 *                        touching the stored choice; day dresses a seasonal
 *                        skin for night N. Reload to snap back.
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
    BLINK_MS: 0.5,         // s gone between fading out and turning up elsewhere

    // THE ROAM SET — for skins with `roam: true` (top view, the page is the
    // floor). All off by default; a roaming skin tunes them up.
    RAPPEL: 75,            // px/s down the silk
    WEAVE_CHANCE: 0,       // per settle-down: stop and start building a web
    RAPPEL_CHANCE: 0,      // per settle-down: let down a line and ride it

    // THE CHASER SET — pursue is the chase that never gives up: full-screen
    // flight straight at the cursor, and on the catch either a PERCH (hung
    // from the pointer as though it were a branch, until it moves away) or,
    // for skins without perch, a told-you-so on the spot.
    PURSUE: 240,           // px/s of pursuit
    PURSUE_CHANCE: 0,      // per settle-down, when the cursor is fresh

    // THE LAMP SET — for skins that are drawn to light. Off by default.
    LAMP: 190,             // px/s toward it
    LAMP_CHANCE: 0,        // per settle-down

    // THE THIEF SET — for skins with `heist` gear. Off by default.
    HEIST_CHANCE: 0,       // per settle-down: walk somewhere, take something,
                           // stash it in the corner hoard

    // THE HAUNT SET — for skins with `haunt` gear. Off by default.
    HAUNT_CHANCE: 0,       // per settle-down: lean on the nearest real thing
    GRAFFITI_CHANCE: 0     // per settle-down: write on the screen
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
    'crouch', 'land', 'drag', 'inflate', 'float', 'pop', 'drift', 'blink',
    'rappel', 'weave', 'pursue', 'perch', 'lamp', 'leave'];

  // ── The manifest ─────────────────────────────────────────────────────────────
  // What the picker offers, renderable before any skin file downloads. `hidden`
  // (when it arrives with the seasonal skins) keeps an entry out of the picker;
  // `rowdy` will mark the obtrusive ones. The default skin leads the list.
  var MANIFEST = [
    { id: 'casey', name: 'Casey', blurb: 'Walks the ledges, naps on your case list.' },
    { id: 'casey95', name: 'Casey-95', blurb: 'The same cat in button-grey plate — and a jetpack.' },
    { id: 'roomba', name: 'Roomba', blurb: 'Floor only. The ledges are safe; the crumbs are not.' },
    { id: 'ghost', name: 'Ghost', blurb: 'Ignores gravity, respects the modals.' },
    { id: 'ufo', name: 'UFO', blurb: 'Hovers, warps, abducts the odd cow.' },
    { id: 'snail', name: 'Snail', blurb: 'Unhurried, and it signs its work.' },
    // rowdy: the picker badges it, and the blurb says plainly what it does — it is
    // opt-in, honestly labelled, and easy to kill, per §2.
    { id: 'spider', name: 'Spider', blurb: 'Roams the page, rappels down silk, webs over anything until you break it.', rowdy: true },
    { id: 'bat', name: 'Bat', blurb: 'Hunts your cursor anywhere on screen, then hangs from it like a branch.' },
    { id: 'goose', name: 'Goose', blurb: 'Tracks mud, honks, and pockets bits of your page. Click her loot to undo.', rowdy: true },
    { id: 'poltergeist', name: 'Poltergeist', blurb: 'Scrawls on your screen and knocks things crooked. Press them to undo.', rowdy: true },
    { id: 'moth', name: 'Moth', blurb: 'Drawn to the light. Follows whatever field you are typing in.' },
    { id: 'dog', name: 'Dog', blurb: 'Throw the ball — press it and drag. It will bring it back to you.' },
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
  var driftUp = false;         // the roost run: drift's climb-to-the-ceiling exit
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
      doc.addEventListener('pointerdown', function (e) {
        h(e);                              // h() has already translated the coords
        clickLoot(mouse.x, mouse.y);
      }, { passive: true });
      doc.addEventListener('pointerup', function (e) {
        h(e);
        releaseThrow(mouse.x, mouse.y);
      }, { passive: true });
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
    if (skin && skin.roam) {
      // on a mission (a heist leg, a plotted next web), the walk goes THERE;
      // otherwise wherever the whim says
      if (heist) { roam.tx = heist.x; roam.ty = heist.y; }
      else if (plannedWeave) { roam.tx = plannedWeave.x; roam.ty = plannedWeave.y; }
      else pickRoamTarget();
      roam.moveUntil = 0; roam.pauseUntil = 0;
    }
  }

  // ── Roam ─────────────────────────────────────────────────────────────────────
  // For skins with roam:true the page is the floor: walk is a free 2D crawl.
  // The character is in the CADENCE — bursts and dead stops, targets that are
  // sometimes an edge to follow (spiders are thigmotactic; the furniture tops
  // scan() already finds are the edges), and sometimes wherever the person is
  // working, which is the bothering clause of the brief.
  var roam = { tx: 0, ty: 0, moveUntil: 0, pauseUntil: 0 };

  function pickRoamTarget() {
    var r = Math.random();
    if (r < 0.3 && mouse.x > 0 && clock - mouse.t < 6) {
      roam.tx = clamp(mouse.x + rand(-90, 90), bounds.left + 14, bounds.right - 14);
      roam.ty = clamp(mouse.y + rand(-70, 70), bounds.top + 14, bounds.bottom - 8);
    } else if (r < 0.55 && ledges.length > 2) {
      var l = ledges[2 + Math.floor(Math.random() * (ledges.length - 2))];
      roam.tx = clamp(rand(l.x1, l.x2), bounds.left + 14, bounds.right - 14);
      roam.ty = clamp(l.y - 2, bounds.top + 14, bounds.bottom - 8);
    } else {
      roam.tx = rand(bounds.left + 14, bounds.right - 14);
      roam.ty = rand(bounds.top + 14, bounds.bottom - 8);
    }
  }

  function roamWalk(dt) {
    var mission = !!(plannedWeave || heist);
    // Bringing it to you means bringing it to where you ARE, so the last leg
    // re-aims every frame. Move the mouse and it changes course mid-trot.
    // …and on the way OUT it chases the ball itself, which may still be
    // bouncing across the floor from the throw.
    if (heist && heist.phase === 'to' && heist.target && heist.target.live) {
      var lv = heist.target.live();
      if (lv) { heist.x = lv.x; heist.y = lv.y; roam.tx = lv.x; roam.ty = lv.y; }
    }
    if (heist && heist.phase === 'back' && skin.heist && skin.heist.to === 'cursor') {
      var d2 = destPoint();
      heist.x = d2.x; heist.y = d2.y;
      roam.tx = d2.x; roam.ty = d2.y;
    }
    if (clock < roam.pauseUntil) {
      if (clock >= stateUntil && !mission) toIdle();
      return;
    }
    if (clock >= roam.moveUntil) {
      if (Math.random() < 0.45) roam.pauseUntil = clock + rand(0.15, 0.8);
      roam.moveUntil = clock + rand(0.35, 1.1);
      // whim retargets only when there is no mission
      if (!mission && Math.random() < 0.25) pickRoamTarget();
    }
    var dx = roam.tx - px, dy = roam.ty - py;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 10) {
      if (heist) {
        if (heist.phase === 'to') {
          // the grab: whatever it came for is in the beak now, and the only
          // remaining business in the world is the corner
          grabLoot(heist.target);
          var s = destPoint();
          heist = { phase: 'back', x: s.x, y: s.y };
          roam.tx = s.x; roam.ty = s.y;
          roam.pauseUntil = clock + 0.5;             // a beat of gloating
          return;
        }
        // the stash: the loot joins the hoard, and it admires its work
        heist = null;
        dropLoot();
        setState('idle', attn());
        stateUntil = clock + rand(1.2, 2.4);
        return;
      }
      if (plannedWeave) {
        // arrived at the plot: break ground on the next web straight away
        plannedWeave = null;
        if (startWeave()) return;
      }
      pickRoamTarget();
      if (clock >= stateUntil) toIdle();
      return;
    }
    px = clamp(px + dx / d * CFG.WALK * dt, bounds.left + 10, bounds.right - 10);
    py = clamp(py + dy / d * CFG.WALK * dt, bounds.top + 12, bounds.bottom - 6);
    if (skin.upright) { rot = 0; aim(dx, 0); }       // the waddle keeps its feet
    else { rot = Math.atan2(dy, dx) * 180 / Math.PI; face = 1; }
    if (clock >= stateUntil) {
      if (mission) stateUntil = clock + 2;           // missions don't dawdle
      else toIdle();
    }
  }

  function toIdle() {
    // The ascent is decided HERE, at the moment the pet stops walking, because
    // a cat that has just settled is the one with time to have an idea. Rolling
    // it on a timer instead meant the timer usually elapsed mid-walk and the
    // chance was silently thrown away, which makes the real frequency a fiction.
    if (clock >= flyReady && Math.random() < CFG.FLY_CHANCE && tryFly(false)) return;
    // The noclip skins lift off instead — the same settle-moment decision —
    // and the roamers roll their pranks here too.
    if (allowed('drift') && Math.random() < CFG.DRIFT_CHANCE) { toDrift(); return; }
    if (allowed('weave') && Math.random() < CFG.WEAVE_CHANCE && startWeave()) return;
    if (allowed('rappel') && Math.random() < CFG.RAPPEL_CHANCE && toRappel()) return;
    if (allowed('pursue') && clock - mouse.t < 5 && Math.random() < CFG.PURSUE_CHANCE && toPursue()) return;
    if (allowed('lamp') && Math.random() < CFG.LAMP_CHANCE && toLamp()) return;
    if (skin.heist && Math.random() < CFG.HEIST_CHANCE && startHeist()) return;
    if (skin.haunt && Math.random() < CFG.HAUNT_CHANCE && startHaunt()) return;
    if (skin.graffiti && Math.random() < CFG.GRAFFITI_CHANCE && startGraffiti()) return;
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
    driftUp = false;
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
    clearPranks();
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
      var ease = Math.min(1, dt * 1.2);
      // The ROOST RUN: a drifter that can hang sometimes ends its wander by
      // climbing the air all the way to the top of the window and latching on
      // upside down — this is how a bat reaches the rafters without ever
      // touching a wall. Committed once begun: no expiry, the ceiling is the
      // exit, and the -72 target means it converges from any height.
      if (driftUp) {
        vx += (Math.sin(clock * 0.8 + driftSeed) * 22 - vx) * ease;
        vy += (-72 - vy) * ease;
        px = clamp(px + vx * dt, bounds.left + 10, bounds.right - 10);
        py = Math.max(py + vy * dt, bounds.top + 16);
        aim(vx, 0);
        if (py <= bounds.top + 18) {
          driftUp = false;
          ledge = null; wall = null;
          rot = 180; py = bounds.top;
          px = clamp(px, bounds.left + 8, bounds.right - 8);
          aim(px > mid() ? -1 : 1, 0);
          setState('hang');
          stateUntil = clock + rand(4, 10);
        }
        return;
      }
      // A slow figure-of-nothing: velocity eases toward a wandering target,
      // so the path curves instead of jittering. No gravity in here — this
      // branch sits above fall/hop for the same reason float does.
      vx += (Math.sin(clock * 0.8 + driftSeed) * 16 - vx) * ease;
      vy += (Math.cos(clock * 0.53 + driftSeed * 2) * 11 - vy) * ease;
      px = clamp(px + vx * dt, bounds.left + 10, bounds.right - 10);
      py = clamp(py + vy * dt, bounds.top + 16, bounds.bottom - 4);
      aim(vx, 0);
      if (clock >= stateUntil) {
        if (allowed('hang') && Math.random() < 0.5) { driftUp = true; return; }
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
      if (skin.roam) {
        // Top view: a thrown thing has nowhere to fall TO — it slides and
        // tumbles across the floor plan until friction wins, and lands where
        // it stops.
        px = clamp(px + vx * dt, bounds.left + 8, bounds.right - 8);
        py = clamp(py + vy * dt, bounds.top + 10, bounds.bottom - 4);
        var fr = Math.pow(0.06, dt);
        vx *= fr; vy *= fr;
        // upright roamers keep their feet: the skid without the spin (the
        // skin's fall pose supplies the flailing)
        if (!skin.upright) rot += 520 * dt * (vx >= 0 ? 1 : -1);
        if (vx * vx + vy * vy < 400) {
          vx = 0; vy = 0;
          setState('land');
          stateUntil = clock + 0.22;
        }
        return;
      }
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
      if (clock >= stateUntil) toWalk();
      return;
    }

    if (state === 'weave') {
      if (!weaving || weaving.o.breaking || objs.indexOf(weaving.o) === -1) {
        weaving = null;
        plannedWeave = null;                            // the chain breaks too
        vx = rand(-170, 170); vy = rand(-120, 120);     // startled — scatter
        setState('fall');
        return;
      }
      // It works ON the web, not under it: orbiting the growing rim at a
      // steady rim speed, headed along the tangent — which is where the silk
      // is actually going down.
      var orbitR = Math.max(5, weaving.o.data.breakR - 5);
      weaving.theta += (30 / orbitR) * dt;
      px = weaving.o.data.cx + Math.cos(weaving.theta) * orbitR;
      py = weaving.o.data.cy + Math.sin(weaving.theta) * orbitR;
      rot = weaving.theta * 180 / Math.PI + 90;
      face = 1;
      var ww = skin.web;
      if (clock >= weaving.next) {
        if (weaving.stage < ww.stages) {
          weaving.stage++;
          weaving.o.el.innerHTML = ww.svg(CFG, weaving.stage);
          weaving.o.el.dataset.stage = String(weaving.stage);
          weaving.o.data.breakR = ww.breakR0 + weaving.stage * ww.breakDr;
          weaving.next = clock + ww.ringS;
        } else {
          // FINISHED. Leave it standing and plot the next one at slight
          // overlap, so the coverage tiles outward across the screen.
          var fr2 = weaving.o.data.breakR;
          var ang = rand(0, Math.PI * 2);
          plannedWeave = {
            x: clamp(weaving.o.data.cx + Math.cos(ang) * fr2 * 1.7, bounds.left + 40, bounds.right - 40),
            y: clamp(weaving.o.data.cy + Math.sin(ang) * fr2 * 1.7, bounds.top + 40, bounds.bottom - 30)
          };
          weaving = null;
          toWalk();
        }
      }
      return;
    }

    if (state === 'pursue') {
      if (mouse.x < 0 || clock - mouse.t > 6) { toFall(vx * 0.25, 0); return; }
      var ptx = mouse.x, pty = mouse.y + 6;
      var pdx = ptx - px, pdy = pty - py;
      var pd = Math.sqrt(pdx * pdx + pdy * pdy);
      if (pd < 14) {
        perchAt.x = mouse.x; perchAt.y = mouse.y;
        if (allowed('perch')) {
          // hung from the pointer as though it were a branch: claws at the
          // cursor, body below (the skin's css turns it over)
          px = perchAt.x;
          py = perchAt.y + CFG.H + 2;
          vx = 0; vy = 0;
          setState('perch');
        } else {
          // caught it, nothing to hang from: a look, and back to its day
          setState('idle', attn());
          stateUntil = clock + rand(1.2, 2.2);
        }
        return;
      }
      // homing with a flap wobble — banking falls out of the easing
      var pk = Math.min(1, dt * 2.2);
      vx += (pdx / pd * CFG.PURSUE - vx) * pk;
      vy += (pdy / pd * CFG.PURSUE - vy) * pk;
      vy += Math.sin(clock * 9) * 40 * dt;
      px = clamp(px + vx * dt, bounds.left + 8, bounds.right - 8);
      py = clamp(py + vy * dt, bounds.top + 10, bounds.bottom - 6);
      aim(vx, 0);
      rot = 0;
      return;
    }

    if (state === 'lamp') {
      if (!lamp) { toFall(0, 0); return; }
      // The light moves: you tab to the next field, the page scrolls. Re-ask
      // on a slow throttle so it FOLLOWS your focus around the form.
      if (clock >= lamp.until) {
        lamp.until = clock + 0.5;
        var fresh = lampRect();
        if (!fresh) { lamp = null; if (!allowed('drift')) { toFall(0, 0); return; } toDrift(); return; }
        lamp.cx = (fresh.x1 + fresh.x2) / 2; lamp.cy = (fresh.y1 + fresh.y2) / 2;
        lamp.hw = (fresh.x2 - fresh.x1) / 2; lamp.hh = (fresh.y2 - fresh.y1) / 2;
      }
      // An erratic circuit of it — the angle jitters and sometimes reverses,
      // because nothing about this is a smooth orbit.
      lamp.theta += lamp.spin * dt * rand(1.1, 2.3);
      if (Math.random() < dt * 0.6) lamp.spin = -lamp.spin;
      var ax = lamp.hw + 16, ay = lamp.hh + 14;
      var tx = lamp.cx + Math.cos(lamp.theta) * ax;
      var ty = lamp.cy + Math.sin(lamp.theta) * ay;
      var lk = Math.min(1, dt * 3.2);
      vx += ((tx - px) * 2.4 - vx) * lk;
      vy += ((ty - py) * 2.4 - vy) * lk;
      // the flutter: it never flies straight at anything
      vx += Math.sin(clock * 17) * 70 * dt;
      vy += Math.cos(clock * 13.5) * 60 * dt;
      var lv = Math.sqrt(vx * vx + vy * vy);
      if (lv > CFG.LAMP) { vx = vx / lv * CFG.LAMP; vy = vy / lv * CFG.LAMP; }
      px = clamp(px + vx * dt, bounds.left + 8, bounds.right - 8);
      py = clamp(py + vy * dt, bounds.top + 10, bounds.bottom - 6);
      // THE §2 LINE, and it is drawn on the BODY rather than on the orbit it
      // is aiming for. Guarding the target is not the same promise: the moth
      // eases toward that point and flutters around it, so overshoot alone
      // could still land it on the words you are typing. This cannot — it is
      // applied last, after everything that moves it, so "never on your text"
      // holds however the physics came out. (An ellipse around a wide, short
      // field also dips back inside it near the corners, which is what makes
      // the aim unsafe in the first place.)
      var gx = lamp.hw + 6, gy = lamp.hh + 6;
      var dxl = px - lamp.cx, dyl = py - lamp.cy;
      if (Math.abs(dxl) < gx && Math.abs(dyl) < gy) {
        // Four ways out of the box; take the nearest one the WINDOW can
        // actually hold. Pushing to the nearest edge alone would shove it off
        // screen whenever the lit field is up against one — this runs after
        // the bounds clamp, so it is the last word on where the moth is.
        var outs = [
          [lamp.cx - gx, py], [lamp.cx + gx, py],
          [px, lamp.cy - gy], [px, lamp.cy + gy]
        ];
        var pick2 = null, pd = 1e9;
        for (var oi = 0; oi < 4; oi++) {
          var ox3 = outs[oi][0], oy3 = outs[oi][1];
          if (ox3 < bounds.left + 8 || ox3 > bounds.right - 8) continue;
          if (oy3 < bounds.top + 10 || oy3 > bounds.bottom - 6) continue;
          var dd = (ox3 - px) * (ox3 - px) + (oy3 - py) * (oy3 - py);
          if (dd < pd) { pd = dd; pick2 = outs[oi]; }
        }
        // Nothing valid means the lit thing fills the window, and there is no
        // honest answer — leave it be rather than teleport it somewhere silly.
        if (pick2) { px = pick2[0]; py = pick2[1]; }
      }
      aim(vx, 0);
      rot = 0;
      if (clock >= stateUntil) {           // it gets distracted, eventually
        lamp = null;
        if (allowed('drift')) toDrift(); else toFall(0, 0);
      }
      return;
    }

    if (state === 'perch') {
      // parked on the catch point until the cursor moves off — then the
      // whole game starts again. Relentless is the brief.
      var qdx = mouse.x - perchAt.x, qdy = mouse.y - perchAt.y;
      if (qdx * qdx + qdy * qdy > 3600) toPursue();
      return;
    }

    if (state === 'rappel') {
      py += CFG.RAPPEL * dt;
      px = rappel.x + Math.sin(clock * 2.1) * 2;
      rot = 90;                                  // head down the page
      positionThread();
      // §2a for the line: the pointer touching it anywhere along its length
      // cuts it, and the rider tumbles.
      if (mouse.x > 0 && Math.abs(mouse.x - rappel.x) < 7 &&
        mouse.y > rappel.y0 - 4 && mouse.y < py) {
        cutThread(true);
        return;
      }
      if (py - rappel.y0 >= rappel.len || py >= bounds.bottom - 8) {
        cutThread(false);
        return;
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

    // walk — and for a roam skin, the walk IS the crawl: no ledge consulted.
    if (skin.roam) { roamWalk(dt); return; }
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
      // side view anchors at the FEET; top view at the CENTRE, because a
      // rotating disc pivots about itself
      ' translate(' + (-CFG.W / 2) + 'px,' + (skin && skin.roam ? -CFG.H / 2 : -CFG.H) + 'px)';

    // the loot rides the beak: just ahead of the face, a little above centre
    if (carried) {
      carried.style.transform =
        'translate3d(' + (px + face * (CFG.W / 2 + 4)).toFixed(1) + 'px,' +
        (py - CFG.H * 0.22).toFixed(1) + 'px,0) translate(-50%,-50%)';
    }

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
    if (flying) flyObjs(dt);
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
      clearPranks();                           // a picked-up weaver stops weaving
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
      // a side-view pet dangles below the hand; a top-view one is just under it
      py = e.clientY + (skin && skin.roam ? 2 : CFG.H * 0.45);
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
        if (ledge || (skin && skin.roam)) { setState('idle', attn()); stateUntil = clock + rand(1.2, 2.5); }
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
    if (!root) return false;
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
    // A forced style flush, NOT a requestAnimationFrame. Setting the target
    // opacity from a rAF callback races the element's first style
    // computation: lose that race and the two values collapse into one, the
    // transition never runs, and the object snaps straight to invisible
    // instead of living out its life. That race is real — every world object
    // this engine has ever dropped was one scheduling decision away from
    // being unseeable, and in a headless browser it loses it every single
    // time. Reading offsetWidth makes the starting opacity real first, which
    // is the entire job.
    void el.offsetWidth;
    el.style.opacity = '0';
    var o = { el: el, kind: kind, data: data || null, breaking: false, timer: 0 };
    o.timer = setTimeout(function () {
      var i2 = objs.indexOf(o);
      if (i2 !== -1) removeObj(i2);
    }, life * 1000);
    objs.push(o);
    return true;
  }

  function removeObj(i) {
    var o = objs[i];
    if (!o) return;
    clearTimeout(o.timer);
    // THE ONE DOOR every loot object leaves by — the fade clock, the cap
    // evicting the oldest, a click, send-away, teardown. Putting the undo
    // here rather than at each of those call sites is what makes "the page
    // always gets its icon back" true by construction.
    if (o.data && o.data.take) { o.data.take.restore(); o.data.take = null; }
    if (o.fly) { o.fly = null; flying--; }
    if (aiming && aiming.o === o) aiming = null;
    o.el.remove();
    objs.splice(i, 1);
  }

  function clearObjs() { while (objs.length) removeObj(0); }

  // The trail: every `every` px of travel in a grounded state, one dropping
  // at the feet. Distance-gated rather than time-gated, so a pet that stops
  // stops leaving them.
  function maybeTrail() {
    var t = skin.trail;
    if (state !== 'walk' && state !== 'chase' && state !== 'climb' && state !== 'hang' &&
      state !== 'drift' && state !== 'lamp') return;
    var dx = px - lastTrail.x, dy = py - lastTrail.y;
    if (dx * dx + dy * dy < t.every * t.every) return;
    lastTrail.x = px; lastTrail.y = py;
    dropObj('trail', px, py, t.svg, t.life, t.max);
  }

  // Webs may sit over ANYTHING — the ruling: a web is never clickable, and
  // reaching whatever it covers means moving the pointer there, which breaks
  // it on the way in. The one person that argument misses is the keyboard
  // user, who tabs into a covered field without ever moving the mouse — so a
  // web that overlaps the FOCUSED field breaks by itself (checked on a slow
  // throttle in breakWebs; layout-dependent, so browsers enforce it and the
  // smoke test pins its presence).
  function focusRect() {
    function grab(doc, ox, oy) {
      try {
        var a = doc.activeElement;
        if (!a) return null;
        var tag = (a.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return null;
        var r = a.getBoundingClientRect();
        if (!r.width && !r.height) return null;
        return { x1: ox + r.left, y1: oy + r.top, x2: ox + r.right, y2: oy + r.bottom };
      } catch (e) { return null; }
    }
    var got = grab(document, 0, 0);
    if (got) return got;
    var f = contentFrame();
    if (f) {
      try {
        var fb = f.getBoundingClientRect();
        if (f.contentDocument) return grab(f.contentDocument, fb.left, fb.top);
      } catch (e) { }
    }
    return null;
  }

  // ── Weaving ──────────────────────────────────────────────────────────────────
  // The web is not an event, it is a PROJECT: the pet settles on a spot and
  // builds outward from it, a ring at a time, until the pointer breaks it —
  // growth pausing (never pushing) at the edge of any field someone is using.
  var weaving = null;      // { o: the web object, stage, next: clock of next ring }

  function startWeave() {
    var w = skin.web;
    if (!w) return false;
    dropObj('web', px, py, w.svg(CFG, 1), w.life, w.max,
      { cx: px, cy: py, breakR: w.breakR0 + w.breakDr });
    var o = objs[objs.length - 1];
    if (!o || o.kind !== 'web') return false;
    o.el.dataset.stage = '1';
    weaving = { o: o, stage: 1, next: clock + w.ringS, theta: rand(0, Math.PI * 2) };
    vx = 0; vy = 0;
    setState('weave');
    return true;
  }

  // Where the NEXT web goes once this one is finished: a plot at slight
  // overlap with the last, so the coverage tiles — wait long enough and the
  // whole screen is silk. Cleared by clearPranks with everything else.
  var plannedWeave = null;

  // ── Rappelling ───────────────────────────────────────────────────────────────
  // A line down the page from wherever it stood, ridden at RAPPEL px/s. The
  // LINE is on the webs' contract: never clickable, and the pointer touching
  // it cuts it — at which point whatever was riding it tumbles.
  var rappel = null;       // { x, y0, len, el }

  function toRappel() {
    if (py > bounds.bottom - 120) return false;
    var el = document.createElement('div');
    el.className = 'yc-thread';
    root.appendChild(el);
    rappel = { x: px, y0: py, len: rand(90, Math.max(100, bounds.bottom - 24 - py)), el: el };
    vx = 0; vy = 0;
    setState('rappel');
    return true;
  }

  function positionThread() {
    if (!rappel) return;
    var h = Math.max(0, (py - CFG.H / 2) - rappel.y0);
    rappel.el.style.transform = 'translate3d(' + Math.round(rappel.x) + 'px,' + Math.round(rappel.y0) + 'px,0)';
    rappel.el.style.height = Math.round(h) + 'px';
  }

  function cutThread(snapped) {
    if (!rappel) return;
    var el = rappel.el;
    el.classList.add('yc-thread-snap');
    setTimeout(function () { el.remove(); }, 300);
    rappel = null;
    if (snapped) {
      // cut out from under it: tumble off sideways
      vx = rand(-170, 170); vy = rand(-60, 140);
      setState('fall');
    } else {
      setState('land');
      stateUntil = clock + 0.22;
    }
  }

  // Every way out of a prank mid-prank: the web stays (fading on its own
  // clock), the thread does not, and neither leaves a handle behind.
  function clearPranks() {
    weaving = null;
    plannedWeave = null;
    if (rappel) { rappel.el.remove(); rappel = null; }
    // a grabbed (or leaving, or stopped) thief drops the goods on the spot,
    // and everything it left crooked stands up straight again
    heist = null;
    lamp = null;
    dropLoot();
    clearHaunts();
  }

  // ── The heist ────────────────────────────────────────────────────────────────
  // For skins with `heist` gear: a two-leg walk mission on the roam machinery
  // (the same no-dawdling wiring as a plotted web). Leg one goes to a spot and
  // takes something — a prop from the skin's kit, or a visual COPY of a word
  // off the page; leg two carries it to the corner and adds it to the hoard.
  // The page itself is never touched: a stolen word is a copy, built through
  // textContent on both sides so markup can never ride along, and the loot is
  // a world object with every .yc-obj promise (no pointer events, a cap, a
  // fade clock — though a long one: a hoard is the point).
  var heist = null;        // { phase: 'to'|'back', x, y, target? }
  var carried = null;      // the element in the beak right now
  var carriedTake = null;  // …and the undo for it, if it was a REAL steal
  var stashSide = 1;       // -1 left corner, +1 right; chosen once per outing

  function stashPoint() {
    return {
      x: stashSide < 0 ? bounds.left + 34 : bounds.right - 34,
      y: bounds.bottom - 26
    };
  }

  // Where the carried thing is going. A hoarder takes it to its corner; a
  // FETCHER brings it to you, which is the same errand with the other ending
  // — and the whole difference between a goose and a dog.
  function destPoint() {
    if (skin.heist && skin.heist.to === 'cursor' && mouse.x > 0) {
      return {
        x: clamp(mouse.x, bounds.left + 20, bounds.right - 20),
        y: clamp(mouse.y + 16, bounds.top + 20, bounds.bottom - 14)
      };
    }
    return stashPoint();
  }

  // A fetcher goes for the ball it already has. Without this it would make a
  // new one every time and the floor would slowly fill with tennis balls.
  function findLootTarget() {
    var best = null, bd = 1e9, i;
    for (i = 0; i < objs.length; i++) {
      var o = objs[i];
      if (o.kind !== 'loot' || o.breaking || !o.data) continue;
      var d = (o.data.x - px) * (o.data.x - px) + (o.data.y - py) * (o.data.y - py);
      if (d < bd) { bd = d; best = o; }
    }
    if (!best) return null;
    var html = best.el.innerHTML, mine = best;
    return {
      x: best.data.x, y: best.data.y,
      // where it is NOW — a thrown ball is still moving
      live: function () {
        return objs.indexOf(mine) === -1 ? null : { x: mine.data.x, y: mine.data.y };
      },
      make: function () {
        var sp = document.createElement('span');
        sp.innerHTML = html;               // its own, from one frame ago
        return sp;
      },
      take: function () {
        var j = objs.indexOf(mine);
        if (j !== -1) removeObj(j);        // in the mouth now, not on the floor
        return null;                       // nothing of yours to give back
      }
    };
  }

  // ── Haunting ─────────────────────────────────────────────────────────────────
  // The steal takes a thing off the page. This DISTURBS one and leaves it
  // there: a card leaning, a heading skewed, a button sitting six pixels
  // wrong. It rights itself — on its own clock, or the moment you press it,
  // or the instant the pet is grabbed or sent away.
  //
  // §2 again, and the same three rules, with one addition of its own:
  //   1. TRANSFORM only. Hit-testing follows a transform, so a tilted button
  //      is still clickable exactly where it now looks — nothing moves out
  //      from under a click, and nothing reflows the page around it. (Every
  //      other way of leaning an element — margin, position, rotate via a
  //      layout property — fails one of those two.)
  //   2. One undo door: unhaunt(). The timer, the press, and every exit all
  //      go through it, so "the page always straightens up" holds by
  //      construction.
  //   3. A ceiling on how much of the page is crooked at once.
  //   …and 4: poses stay SMALL. A big throw would push an element over its
  //      neighbour, and covering a control is the one thing the tilt must
  //      never do.
  var haunts = [];         // [{ el, wasT, wasTr, timer }]

  function unhaunt(h) {
    var i = haunts.indexOf(h);
    if (i !== -1) haunts.splice(i, 1);
    clearTimeout(h.timer);
    try {
      h.el.style.transition = h.wasTr;
      h.el.style.transform = h.wasT;
      h.el.__ycHaunted = 0;
      h.el.classList.remove('yc-haunted');
    } catch (e) { }
  }

  function clearHaunts() { while (haunts.length) unhaunt(haunts[0]); }

  // Something worth disturbing, and near the pet — so it reads as the pet's
  // doing rather than a page that wobbles by itself.
  function findHauntTarget() {
    var h = skin.haunt;
    if (haunts.length >= h.max) return null;
    function hunt(doc, ox, oy) {
      try {
        var els = doc.querySelectorAll(h.sel || 'button,.card,tr,th,h1,h2,h3,img,.big-button');
        var best = null, bestD = 1e9, n = Math.min(els.length, CFG.SCAN_ELS);
        for (var i = 0; i < n; i++) {
          var el = els[i];
          if (el.__ycHaunted) continue;
          if (el.closest && (el.closest('#yc-mascot') || el.closest('.swal2-container'))) continue;
          if (!el.getClientRects().length) continue;
          var r = el.getBoundingClientRect();
          // big enough to read as furniture, small enough not to BE the page
          if (r.width < 28 || r.height < 14) continue;
          if (r.width > 900 || r.height > 500) continue;
          var cx = ox + r.left + r.width / 2, cy = oy + r.top + r.height / 2;
          if (cx < bounds.left || cx > bounds.right || cy < bounds.top || cy > bounds.bottom) continue;
          var d = (cx - px) * (cx - px) + (cy - py) * (cy - py);
          if (d < bestD) { bestD = d; best = el; }
        }
        return best;
      } catch (e) { return null; }
    }
    var got = null, f = contentFrame();
    if (f) {
      try {
        var fb = f.getBoundingClientRect();
        if (f.contentDocument) got = hunt(f.contentDocument, fb.left, fb.top);
      } catch (e) { }
    }
    if (!got) got = hunt(document, 0, 0);
    return got;
  }

  // ── Graffiti ─────────────────────────────────────────────────────────────────
  // The loud one. A tilt is a prank; writing across somebody's screen is the
  // chaos the rowdy badge is actually promising. It lands on the world-object
  // layer with every promise that layer makes — it cannot take a click, it is
  // capped, it fades on a clock — plus the one this arc has added to
  // everything the pet does to your page: pressing it wipes it off.
  //
  // The engine places it and owns its life; the SKIN draws it, because what a
  // given form scrawls (and in what hand) is entirely that form's business.
  function startGraffiti() {
    var g = skin.graffiti;
    if (!g) return false;
    var w = Math.min(420, Math.max(180, (bounds.right - bounds.left) * 0.42));
    var h = 92;
    var lo = bounds.left + w / 2 + 10, hi = Math.max(lo, bounds.right - w / 2 - 10);
    var tp = bounds.top + h / 2 + 10, bt = Math.max(tp, bounds.bottom - h / 2 - 10);
    // Somewhere it will actually be read, fully on the screen, and NOT on top
    // of the last one — two scrawls in the same place are not twice as rude,
    // they are one illegible smear. Try a few spots and take the first clear
    // one, or the roomiest if the screen is already covered.
    var x = 0, y = 0, best = -1, i, k;
    for (k = 0; k < 14; k++) {
      var cx = rand(lo, hi), cy = rand(tp, bt), worst = 1e9;
      for (i = 0; i < objs.length; i++) {
        var o2 = objs[i];
        if (o2.kind !== 'graffiti' || !o2.data) continue;
        var ox4 = Math.abs(cx - o2.data.x) / w, oy4 = Math.abs(cy - o2.data.y) / h;
        worst = Math.min(worst, Math.max(ox4, oy4));
      }
      if (worst > best) { best = worst; x = cx; y = cy; }
      if (worst >= 1) break;                       // clear of everything: done
    }
    // …and not the word that is already up there. Two OBJECTIONs on one
    // screen looks like a bug; two different words look like a vandal.
    var up = {}, pool = [];
    for (i = 0; i < objs.length; i++) {
      if (objs[i].kind === 'graffiti' && objs[i].data) up[objs[i].data.text] = 1;
    }
    for (i = 0; i < g.texts.length; i++) if (!up[g.texts[i]]) pool.push(g.texts[i]);
    if (!pool.length) pool = g.texts;
    var text = pool[Math.floor(Math.random() * pool.length)];
    var tilt = rand(-9, 9);
    if (!dropObj('graffiti', x, y, g.svg(CFG, text, tilt, w, h), g.life, g.max,
      { x: x, y: y, w: w, h: h, text: text })) return false;
    return true;
  }

  function startHaunt() {
    if (!skin.haunt) return false;
    var el = findHauntTarget();
    if (!el) return false;
    var h = skin.haunt;
    var pose = h.poses[Math.floor(Math.random() * h.poses.length)];
    var rec = { el: el, wasT: el.style.transform, wasTr: el.style.transition, timer: 0 };
    el.__ycHaunted = 1;
    el.style.transition = 'transform .45s cubic-bezier(.3,1.5,.5,1)';
    el.style.transform = (rec.wasT ? rec.wasT + ' ' : '') + pose;
    el.classList.add('yc-haunted');
    rec.timer = setTimeout(function () { unhaunt(rec); }, h.life * 1000);
    haunts.push(rec);
    return true;
  }

  // ── Real theft ───────────────────────────────────────────────────────────────
  // The word heist takes a COPY. This one takes the thing itself: an icon off
  // the page goes invisible and turns up in the hoard, and the page has a hole
  // in it until she is made to give it back.
  //
  // Three rules keep that inside §2, which permits obtrusive-visual-and-
  // temporal but never obtrusive-input:
  //   1. OPACITY, never visibility or display. An icon is very often the click
  //      target itself (<i class="fa-trash" onclick=…>); visibility:hidden
  //      would stop it taking that click, and display:none would reflow the
  //      page around it. At opacity 0 the element is still laid out, still
  //      hit-testable, still keyboard-reachable — only invisible.
  //   2. Every exit restores. The undo lives in removeObj(), which is the one
  //      door every loot object leaves by: the fade clock, the cap evicting
  //      the oldest, a click, send-away, teardown.
  //   3. A hard ceiling on how much of the real page can be missing at once.
  var MAX_REAL = 3;
  // FA's own class tokens, and nothing else: a rebuilt <i> carries these and
  // no other attribute, child or text — the same no-foreign-markup guarantee
  // the word heist gets from textContent.
  var FA_TOKEN = /^fa[srlbdtk]?$|^fa-[a-z0-9-]+$/;

  function faClasses(el) {
    var tag = (el.tagName || '').toLowerCase(), out = [], i;
    // FA's svg-with-js mode replaces the <i> with an <svg> that names the icon
    // it drew; rebuild the <i> the CSS mode would have had.
    if (tag === 'svg') {
      var pre = el.getAttribute('data-prefix'), ic = el.getAttribute('data-icon');
      if (pre && ic && FA_TOKEN.test(pre) && /^[a-z0-9-]+$/.test(ic)) return [pre, 'fa-' + ic];
      return [];
    }
    var cl = el.getAttribute('class') || '';
    var parts = cl.split(/\s+/);
    for (i = 0; i < parts.length; i++) {
      if (parts[i] && FA_TOKEN.test(parts[i])) out.push(parts[i]);
    }
    // 'fa-solid' alone is a style with no glyph — it has to name an icon too.
    return out.length > 1 ? out : [];
  }

  function realSteals() {
    var n = carriedTake ? 1 : 0;
    for (var i = 0; i < objs.length; i++) if (objs[i].data && objs[i].data.take) n++;
    return n;
  }

  // An icon worth taking. Anything inside the pet's own layer or the trick
  // panel is off limits — she is not stealing her own loot, and the buttons
  // that control her stay legible.
  function findIconTarget() {
    if (realSteals() >= MAX_REAL) return null;
    function hunt(doc, ox, oy, frame) {
      try {
        var els = doc.querySelectorAll('i[class*="fa-"],svg.svg-inline--fa');
        var picks = [], i;
        for (i = 0; i < els.length && picks.length < 40; i++) {
          var el = els[i];
          if (el.__ycStolen) continue;                       // already in the hoard
          if (el.closest && (el.closest('#yc-mascot') || el.closest('.swal2-container'))) continue;
          if (!el.getClientRects().length) continue;
          var cls = faClasses(el);
          if (!cls.length) continue;
          var r = el.getBoundingClientRect();
          if (r.width < 6 || r.height < 6 || r.width > 80) continue;
          var x = ox + r.left + r.width / 2, y = oy + r.top + r.height / 2;
          if (x < bounds.left + 12 || x > bounds.right - 12 ||
            y < bounds.top + 14 || y > bounds.bottom - 8) continue;
          picks.push({ el: el, cls: cls, x: x, y: y, frame: frame });
        }
        return picks.length ? picks[Math.floor(Math.random() * picks.length)] : null;
      } catch (e) { return null; }
    }
    var got = null, f = contentFrame();
    if (f) {
      try {
        var fb = f.getBoundingClientRect();
        if (f.contentDocument) got = hunt(f.contentDocument, fb.left, fb.top, f);
      } catch (e) { }
    }
    if (!got) got = hunt(document, 0, 0, null);
    if (!got) return null;

    var victim = got.el, cls = got.cls, frame = got.frame;
    var tint = '';
    try {
      // the victim's OWN view — it may live in the content frame's document
      var vw2 = victim.ownerDocument && victim.ownerDocument.defaultView;
      tint = ((vw2 || window).getComputedStyle(victim) || {}).color || '';
    } catch (e) { }
    return {
      x: got.x, y: got.y,
      make: function () {
        var i2 = document.createElement('i');
        i2.className = cls.join(' ');        // FA TOKENS ONLY — nothing else crosses
        if (tint) i2.style.color = tint;     // …and its colour, so the steal looks like the theft
        return i2;
      },
      // Called at the moment of the grab, not when the job is plotted: she has
      // to actually get there, and the page may have moved on in between.
      take: function () {
        if (!victim.isConnected || victim.__ycStolen) return null;
        var was = victim.style.opacity;
        victim.__ycStolen = 1;
        victim.style.opacity = '0';
        return {
          // where it belongs, recomputed live — the page scrolls, the layout reflows
          where: function () {
            try {
              if (!victim.isConnected) return null;
              var r2 = victim.getBoundingClientRect();
              if (!r2.width && !r2.height) return null;
              var ox2 = 0, oy2 = 0;
              if (frame) { var fr2 = frame.getBoundingClientRect(); ox2 = fr2.left; oy2 = fr2.top; }
              return { x: ox2 + r2.left + r2.width / 2, y: oy2 + r2.top + r2.height / 2 };
            } catch (e) { return null; }
          },
          restore: function () {
            try {
              victim.style.opacity = was;
              victim.__ycStolen = 0;
            } catch (e) { }
          }
        };
      }
    };
  }

  // A word worth taking: the open page's headings, labels and buttons first
  // (that is where the good words are), the shell's own as the fallback.
  // Only ever READ — the copy is what gets stolen.
  function findWordTarget() {
    function hunt(doc, ox, oy) {
      try {
        var els = doc.querySelectorAll('h1,h2,h3,th,label,button');
        var picks = [];
        for (var i = 0; i < els.length && picks.length < 40; i++) {
          var el = els[i];
          if (!el.getClientRects().length) continue;
          var word = (el.textContent || '').trim().split(/\s+/)[0] || '';
          if (word.length < 3 || word.length > 14) continue;
          var r = el.getBoundingClientRect();
          var x = ox + r.left + Math.min(30, r.width / 2);
          var y = oy + r.top + r.height / 2;
          if (x < bounds.left + 12 || x > bounds.right - 12 ||
            y < bounds.top + 14 || y > bounds.bottom - 8) continue;
          picks.push({ x: x, y: y, word: word });
        }
        return picks.length ? picks[Math.floor(Math.random() * picks.length)] : null;
      } catch (e) { return null; }
    }
    var got = null, f = contentFrame();
    if (f) {
      try {
        var fb = f.getBoundingClientRect();
        if (f.contentDocument) got = hunt(f.contentDocument, fb.left, fb.top);
      } catch (e) { }
    }
    if (!got) got = hunt(document, 0, 0);
    if (!got) return null;
    var word = got.word;
    return {
      x: got.x, y: got.y,
      make: function () {
        var span = document.createElement('span');
        span.className = 'yc-word';
        span.textContent = word;      // TEXT ONLY — this is the safety, whole
        return span;
      }
    };
  }

  function propTarget() {
    var props = skin.heist.props;
    var svg = props[Math.floor(Math.random() * props.length)];
    return {
      // props are simply "lying around": an unremarkable spot becomes, on
      // arrival, the place this envelope always was
      x: rand(bounds.left + 40, bounds.right - 40),
      y: rand(bounds.top + 40, bounds.bottom - 40),
      make: function () {
        var el = document.createElement('span');
        el.innerHTML = svg;           // skin-authored, like a trail's art
        return el;
      }
    };
  }

  function startHeist() {
    if (!skin.heist || heist || carried) return false;
    // What she fancies today: usually the real thing, often a word, and
    // otherwise whatever is lying around — with the page hunts falling back
    // to props, because a page with no icons and no headings still owes her
    // something.
    var t = null;
    if (skin.heist.to === 'cursor') {
      // A fetcher does not take your things apart. Its own ball, or a new one.
      t = findLootTarget();
    } else {
      var r = Math.random();
      var order = r < 0.45 ? [findIconTarget, findWordTarget]
        : r < 0.75 ? [findWordTarget, findIconTarget] : [];
      for (var i = 0; i < order.length && !t; i++) t = order[i]();
    }
    if (!t) t = propTarget();
    heist = { phase: 'to', x: t.x, y: t.y, target: t };
    toWalk();
    return true;
  }

  function grabLoot(t) {
    carried = document.createElement('div');
    carried.className = 'yc-obj yc-carried';
    carried.appendChild(t.make());
    root.appendChild(carried);
    cat.dataset.carry = '1';
    // THE THEFT ITSELF, for the kinds that have one — done on arrival, so
    // what she takes is what was there when she got there.
    carriedTake = t.take ? t.take() : null;
  }

  // The loot lands wherever the carrier stands — normally the hoard, but
  // clearPranks drops it mid-heist too (a grabbed thief drops the goods).
  function dropLoot() {
    if (!carried) return;
    var lx = px + rand(-14, 14), ly = py + rand(-12, 4);
    var placed = dropObj('loot', lx, ly, carried.innerHTML, 300, 14,
      { x: lx, y: ly, r: 16, take: carriedTake });
    // If the world layer is already gone there is nowhere to put it, and the
    // loot object that would have carried the undo never exists. A theft must
    // never outlive the pet, so it ends here instead.
    if (!placed && carriedTake) carriedTake.restore();
    carried.remove();
    carried = null;
    carriedTake = null;
    if (cat) cat.removeAttribute('data-carry');
  }

  // ── Giving it back ───────────────────────────────────────────────────────────
  // There is no "unsteal" gesture to learn: you click the thing. The click is
  // a COORDINATE test against the loot's own position — the same trick the
  // webs' break uses, and for the same reason. Loot never takes pointer
  // events, so the click also reaches whatever is underneath it; nothing the
  // pet drops can ever swallow one.
  function returnLoot(o) {
    o.breaking = true;
    clearTimeout(o.timer);
    var home = o.data.take && o.data.take.where();
    if (home) {
      // a real steal goes HOME: the engine flies it back (so the skin never
      // has to know where home is), and the icon reappears as it lands
      o.el.classList.add('yc-obj-return');
      o.el.style.transition = 'transform .42s cubic-bezier(.3,.85,.4,1),opacity .42s ease';
      o.el.style.transform =
        'translate3d(' + Math.round(home.x) + 'px,' + Math.round(home.y) + 'px,0) scale(.55)';
      o.el.style.opacity = '0';
    } else {
      // a copy was never anywhere. It simply stops being.
      o.el.classList.add('yc-obj-poof');
    }
    o.timer = setTimeout(function () {
      var j = objs.indexOf(o);
      if (j !== -1) removeObj(j);        // …and removeObj is where the undo lives
    }, 430);
  }

  // A press on something crooked straightens it. Same contract as the loot:
  // a coordinate test, no listener on the victim, so the press still does
  // whatever it was going to do to the page.
  function clickHaunt(x, y) {
    for (var i = haunts.length - 1; i >= 0; i--) {
      var h = haunts[i], r;
      try { r = h.el.getBoundingClientRect(); } catch (e) { continue; }
      var ox = 0, oy = 0, f = contentFrame();
      // a haunted element inside the content frame reports frame coordinates
      if (f && h.el.ownerDocument !== document) {
        try { var fb = f.getBoundingClientRect(); ox = fb.left; oy = fb.top; } catch (e) { }
      }
      if (x < ox + r.left || x > ox + r.right || y < oy + r.top || y > oy + r.bottom) continue;
      unhaunt(h);
      return true;
    }
    return false;
  }

  function clickLoot(x, y) {
    if (!running || !root) return;
    clickHaunt(x, y);
    // Caught red-handed: clicking what is in the beak takes it straight back,
    // and the job dies with it.
    if (carried) {
      var bx = px + face * (CFG.W / 2 + 4), by = py - CFG.H * 0.22;
      if ((x - bx) * (x - bx) + (y - by) * (y - by) < 324) {
        if (carriedTake) carriedTake.restore();
        carried.remove();
        carried = null; carriedTake = null;
        if (cat) cat.removeAttribute('data-carry');
        heist = null;
        setState('idle', attn());        // outrage
        stateUntil = clock + rand(1.2, 2.2);
        return;
      }
    }
    for (var i = objs.length - 1; i >= 0; i--) {
      var o = objs[i];
      if (o.breaking || !o.data) continue;
      if (o.kind === 'loot') {
        var dx = x - o.data.x, dy = y - o.data.y;
        if (dx * dx + dy * dy > o.data.r * o.data.r) continue;
        // A FETCHER's ball is not yours to take back — it was never taken.
        // Pressing it picks it up to THROW: drag and let go, or just let go
        // where you are for a lob. A hoarder's loot still comes home.
        if (skin.heist && skin.heist.to === 'cursor') {
          aiming = { o: o, x0: x, y0: y };
          return;
        }
        returnLoot(o);
        return;                          // one per click: a hoard is undone piece by piece
      }
      if (o.kind === 'graffiti') {
        // A box rather than a radius — scrawl is wide and short, and the
        // whole of it should rub out, not just its middle.
        if (Math.abs(x - o.data.x) > o.data.w / 2) continue;
        if (Math.abs(y - o.data.y) > o.data.h / 2) continue;
        wipeObj(o);
        return;
      }
    }
  }

  // ── Thrown things ────────────────────────────────────────────────────────────
  // Until now every world object stayed exactly where it was dropped. A ball
  // you can throw needs one that does not: pick it up with a press, fling it,
  // and it arcs, bounces and rolls to a stop — at which point it is an
  // ordinary bit of loot again, lying wherever it ended up, for the dog to go
  // and get. `flying` is a plain count so the frame loop pays nothing at all
  // on every other form.
  var flying = 0;

  function flyObjs(dt) {
    for (var i = 0; i < objs.length; i++) {
      var o = objs[i];
      if (!o.fly) continue;
      var f = o.fly;
      f.vy += 1500 * dt;                          // it is a ball, not a feather
      o.data.x += f.vx * dt;
      o.data.y += f.vy * dt;
      f.spin += f.vx * dt * 1.6;
      // the walls and the floor
      if (o.data.x < bounds.left + 8) { o.data.x = bounds.left + 8; f.vx = Math.abs(f.vx) * 0.5; }
      if (o.data.x > bounds.right - 8) { o.data.x = bounds.right - 8; f.vx = -Math.abs(f.vx) * 0.5; }
      if (o.data.y > bounds.bottom - 10) {
        o.data.y = bounds.bottom - 10;
        f.vy = -Math.abs(f.vy) * 0.42;            // bounce, losing most of it
        f.vx *= 0.72;                             // and scrub along the ground
        if (Math.abs(f.vy) < 60) f.vy = 0;
      }
      if (o.data.y < bounds.top + 8) { o.data.y = bounds.top + 8; f.vy = Math.abs(f.vy) * 0.4; }
      o.el.style.transform = 'translate3d(' + Math.round(o.data.x) + 'px,' +
        Math.round(o.data.y) + 'px,0) rotate(' + Math.round(f.spin) + 'deg)';
      // settled: it is just loot again, and the dog knows where it is
      if (f.vy === 0 && Math.abs(f.vx) < 26) {
        o.el.classList.remove('yc-obj-thrown');
        o.fly = null;
        flying--;
      }
    }
  }

  var aiming = null;       // { o, x0, y0 } — a ball held, waiting to be let go

  // Let go. A real drag throws along it; a plain press lobs the ball away
  // from the pet, so a click still counts as a throw.
  function releaseThrow(x, y) {
    if (!aiming) return;
    var a = aiming; aiming = null;
    if (objs.indexOf(a.o) === -1) return;
    var dx = x - a.x0, dy = y - a.y0;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 12) {
      var away = a.o.data.x >= px ? 1 : -1;
      throwObj(a.o, away * rand(240, 400), rand(-560, -420));
      return;
    }
    var sp = Math.min(1500, d * 7);
    throwObj(a.o, dx / d * sp, dy / d * sp - 140);   // a little loft, always
  }

  function throwObj(o, vx, vy) {
    if (o.fly) return;
    // A thrown ball has outstayed its fade — give it its life back, or it
    // blinks out mid-air.
    clearTimeout(o.timer);
    o.el.style.transition = 'none';
    o.el.style.opacity = '1';
    o.el.classList.add('yc-obj-thrown');
    o.fly = { vx: vx, vy: vy, spin: 0 };
    flying++;
    o.timer = setTimeout(function () {
      var j = objs.indexOf(o);
      if (j !== -1) removeObj(j);
    }, 300000);
  }

  // Rubbed out: the skin animates .yc-obj-wipe, the engine takes it away.
  function wipeObj(o) {
    o.breaking = true;
    clearTimeout(o.timer);
    o.el.classList.add('yc-obj-wipe');
    o.timer = setTimeout(function () {
      var j = objs.indexOf(o);
      if (j !== -1) removeObj(j);
    }, 430);
  }

  // ── The lamp ─────────────────────────────────────────────────────────────────
  // Some things are drawn to light, and in an app the light is wherever you
  // are working: the field you are typing in. focusRect() already knows how to
  // find that — it was built so a web over the focused input breaks itself —
  // and this is the same knowledge used for the opposite purpose. Nothing
  // focused? Then the brightest large thing on screen, which is a real answer
  // and not a fallback: a moth in a dark room goes to the lightest wall.
  //
  // It orbits the OUTSIDE of whatever it finds. That is not decoration: a moth
  // sitting in the middle of the field you are typing in would be covering
  // your text, and §2 draws the line exactly there.
  var lamp = null;         // { cx, cy, hw, hh, theta, spin, until }
  var brightAt = -1e9, brightCache = null;

  function luminance(css) {
    var m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[, /]+([\d.]+))?/.exec(css || '');
    if (!m) return -1;
    if (m[4] !== undefined && Number(m[4]) < 0.35) return -1;   // effectively transparent
    return 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
  }

  // The lightest sizeable thing in view. Cached: this walks real styles, and
  // the answer does not change between blinks of an eye.
  function brightestRect() {
    if (clock - brightAt < 3 && brightCache) return brightCache;
    brightAt = clock;
    brightCache = null;
    function hunt(doc, ox, oy) {
      try {
        var els = doc.querySelectorAll('input,textarea,select,button,.card,td,th,h1,h2,.panel,.tile');
        var best = null, bestL = 40, n = Math.min(els.length, 160);
        for (var i = 0; i < n; i++) {
          var el = els[i];
          if (el.closest && el.closest('#yc-mascot')) continue;
          if (!el.getClientRects().length) continue;
          var r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 16) continue;
          var view = el.ownerDocument && el.ownerDocument.defaultView;
          var L = luminance(((view || window).getComputedStyle(el) || {}).backgroundColor);
          if (L <= bestL) continue;
          bestL = L;
          best = { x1: ox + r.left, y1: oy + r.top, x2: ox + r.right, y2: oy + r.bottom };
        }
        return best;
      } catch (e) { return null; }
    }
    var f = contentFrame();
    if (f) {
      try {
        var fb = f.getBoundingClientRect();
        if (f.contentDocument) brightCache = hunt(f.contentDocument, fb.left, fb.top);
      } catch (e) { }
    }
    if (!brightCache) brightCache = hunt(document, 0, 0);
    return brightCache;
  }

  function lampRect() { return focusRect() || brightestRect(); }

  function toLamp() {
    var r = lampRect();
    if (!r) return false;
    ledge = null; wall = null; rot = 0;
    hop = null; hopFloor = -1e9; fly = null;
    lamp = {
      cx: (r.x1 + r.x2) / 2, cy: (r.y1 + r.y2) / 2,
      hw: (r.x2 - r.x1) / 2, hh: (r.y2 - r.y1) / 2,
      theta: rand(0, Math.PI * 2),
      spin: Math.random() < 0.5 ? -1 : 1,
      until: 0
    };
    setState('lamp');
    stateUntil = clock + rand(7, 16);
    return true;
  }

  // ── Pursuit ──────────────────────────────────────────────────────────────────
  // The chase that never gives up: airborne homing on the cursor, wherever it
  // goes, however long it takes. The catch depends on the skin: with 'perch'
  // in its can it PERCHES at the catch point — hung upside down, the pointer
  // for a branch — until the cursor moves off; without it, it stops, gives
  // the cursor a look, and resumes its day. Interest lapses only when the
  // cursor has been still for a long six seconds mid-flight.
  var perchAt = { x: 0, y: 0 };

  function toPursue() {
    if (mouse.x < 0) return false;
    ledge = null; wall = null; rot = 0;
    hop = null; hopFloor = -1e9; fly = null;
    setState('pursue');
    return true;
  }

  // §2a's enforcement, all of it: a web breaks when the POINTER comes near —
  // a distance test against the tracked cursor, run each frame over at most
  // `max` webs. No web ever has pointer events, so there is no click to
  // swallow; a touch tap breaks on first contact because pointerdown feeds
  // the same tracker; and a fast move-and-click inside one frame cannot slip
  // through a thing that was never clickable.
  var nextFocusCheck = 0;
  function breakOne(o) {
    o.breaking = true;
    clearTimeout(o.timer);
    o.el.classList.add('yc-obj-break');
    o.timer = setTimeout(function () {
      var j = objs.indexOf(o);
      if (j !== -1) removeObj(j);
    }, 450);
  }

  function breakWebs() {
    // the keyboard clause, on a slow throttle: a web over the focused field
    // breaks without the mouse ever moving
    var fr = null;
    if (clock >= nextFocusCheck) {
      nextFocusCheck = clock + 0.8;
      fr = focusRect();
    }
    for (var i = objs.length - 1; i >= 0; i--) {
      var o = objs[i];
      if (o.kind !== 'web' || o.breaking || !o.data) continue;
      var R = o.data.breakR;
      if (fr && o.data.cx + R > fr.x1 && o.data.cx - R < fr.x2 &&
        o.data.cy + R > fr.y1 && o.data.cy - R < fr.y2) {
        breakOne(o);
        continue;
      }
      if (mouse.x < 0) continue;
      var dx = mouse.x - o.data.cx, dy = mouse.y - o.data.cy;
      if (dx * dx + dy * dy > R * R) continue;
      breakOne(o);
      // Mostly one at a time; sometimes the whole neighbourhood goes — a
      // ripple through every OVERLAPPING web, a generation at a time.
      if (Math.random() < 0.35) cascadeFrom(o);
    }
  }

  function cascadeFrom(seed) {
    var frontier = [seed], depth = 0;
    while (frontier.length && depth < 12) {
      depth++;
      var next = [], i, j;
      for (i = 0; i < objs.length; i++) {
        var o = objs[i];
        if (o.kind !== 'web' || o.breaking || !o.data) continue;
        for (j = 0; j < frontier.length; j++) {
          var f = frontier[j];
          var dx = o.data.cx - f.data.cx, dy = o.data.cy - f.data.cy;
          var rr = o.data.breakR + f.data.breakR;
          if (dx * dx + dy * dy <= rr * rr) { next.push(o); break; }
        }
      }
      for (i = 0; i < next.length; i++) {
        (function (ob, dly) {
          setTimeout(function () {
            if (!ob.breaking && objs.indexOf(ob) !== -1) breakOne(ob);
          }, dly);
        })(next[i], depth * 70);
      }
      frontier = next;
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
      // z-index 2: the pet rides ON TOP of anything it leaves in the world —
      // a weaver on its web, never under it (objects sit at 1, below).
      '.yc-cat{position:absolute;left:0;top:0;z-index:2;width:' + CFG.W + 'px;height:' + CFG.H + 'px;',
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
      '.yc-obj,.yc-obj *,.yc-thread{pointer-events:none!important}',
      '.yc-obj{position:absolute;left:0;top:0;z-index:1;will-change:opacity}',
      '.yc-obj svg{display:block;overflow:visible}',
      // a stolen word: engine-styled so every thief's word-loot reads the
      // same — a little paper scrap of a thing
      '.yc-word{display:inline-block;font:600 12px/1.35 system-ui,"Segoe UI",sans-serif;',
      'color:#3A3F4A;background:rgba(255,253,246,.92);padding:0 4px;border-radius:3px;',
      'box-shadow:0 1px 2px rgba(0,0,0,.22);white-space:nowrap}',
      // a stolen icon keeps its own colour but not the page's font sizing —
      // an inherited 2rem glyph in the beak would be a different joke
      '.yc-obj i,.yc-carried i{font-size:15px;line-height:1;display:inline-block}',
      // what is in the beak rides ABOVE the pet (.yc-cat is z:2); everything
      // already dropped stays behind her at the world-object z:1
      '.yc-carried{z-index:3;will-change:transform}',
      // the rappel line: engine-owned, engine-styled, cut by the pointer
      '.yc-thread{position:absolute;left:0;top:0;z-index:1;width:2px;margin-left:-1px;',
      'background:linear-gradient(rgba(185,194,207,.9),rgba(185,194,207,.45));',
      'transition:opacity .2s ease}',
      '.yc-thread-snap{opacity:0}',
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
    if (skin.roam) {
      // top view: nothing to drop in FROM — it turns up somewhere on the
      // floor plan, mid-scurry, as though it was always there
      px = rand(bounds.left + 30, bounds.right - 30);
      py = rand(bounds.top + 30, bounds.bottom - 30);
      if (skin.upright) { rot = 0; face = Math.random() < 0.5 ? -1 : 1; }
      else { rot = rand(0, 360); face = 1; }
      vx = 0; vy = 0;
      stashSide = Math.random() < 0.5 ? -1 : 1;      // the hoard corner, chosen once per outing
      setState('land');
      stateUntil = clock + 0.22;
    } else {
      px = bounds.left + (bounds.right - bounds.left) * rand(0.35, 0.65);
      py = bounds.top - 40;
      toFall(rand(-20, 20), 0);          // drops in from off the top
    }
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
    clearPranks();
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
      if (ok && has('weave') && !(def.web && def.roam)) ok = false;   // weaving needs a web, and the floor plan
      if (ok && has('rappel') && !def.roam) ok = false;              // rappelling is a top-view trick
      if (ok && has('perch') && !has('pursue')) ok = false;          // a perch is where a pursuit ends
    }
    // A trail keeps its own promises: real spacing, a finite life, a cap.
    if (ok && def.trail) {
      ok = def.trail.every > 0 && def.trail.life > 0 && def.trail.max > 0 && !!def.trail.svg;
    }
    // …and a web keeps §2a's: a ring clock, a ring cap, a lifetime, a web
    // cap, and a break radius that grows with the rings.
    if (ok && def.web) {
      var wb = def.web;
      ok = wb.ringS > 0 && wb.stages > 0 && wb.life > 0 && wb.max > 0 &&
        wb.breakR0 > 0 && wb.breakDr >= 0 && typeof wb.svg === 'function';
    }
    // The thief's kit: heists run on the roam machinery, and an empty kit
    // would strand the prop half of every job.
    if (ok && def.heist) {
      ok = !!def.roam && !!def.heist.props && def.heist.props.length > 0;
      for (var hp = 0; ok && hp < def.heist.props.length; hp++) {
        ok = typeof def.heist.props[hp] === 'string';
      }
      // …and it has to deliver somewhere the engine knows about
      if (ok && def.heist.to !== undefined) {
        ok = def.heist.to === 'stash' || def.heist.to === 'cursor';
      }
    }
    // upright is a roam variant — without roam there is nothing to vary.
    if (ok && def.upright && !def.roam) ok = false;
    // The graffiti kit: something to write, a ceiling, a clock, and a hand.
    if (ok && def.graffiti) {
      var gf = def.graffiti;
      ok = !!gf.texts && gf.texts.length > 0 && gf.max > 0 && gf.life > 0 &&
        typeof gf.svg === 'function';
      for (var gi = 0; ok && gi < gf.texts.length; gi++) {
        ok = typeof gf.texts[gi] === 'string' && gf.texts[gi].length > 0;
      }
    }
    // The haunt kit: a ceiling, a clock, and at least one pose to strike.
    if (ok && def.haunt) {
      ok = def.haunt.max > 0 && def.haunt.life > 0 &&
        !!def.haunt.poses && def.haunt.poses.length > 0;
      for (var hq = 0; ok && hq < def.haunt.poses.length; hq++) {
        ok = typeof def.haunt.poses[hq] === 'string';
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
      name: 'weave', needs: 'any', gate: 'weave', what: 'settle in and build a web until somebody breaks it',
      run: function () { if (!startWeave()) return 'no web in this form'; }
    },
    {
      name: 'rappel', needs: 'any', gate: 'rappel', what: 'let down a line and ride it down the page',
      run: function () { if (!toRappel()) return 'not enough page below'; }
    },
    {
      name: 'pursue', needs: 'any', gate: 'pursue', what: 'hunt the cursor down, however far it runs',
      run: function () { if (!toPursue()) return 'move the mouse first — it has not seen the cursor yet'; }
    },
    {
      // `when` rather than a gate: stealing is not a state, it is a walk with
      // intent, so what decides is the heist gear rather than the can mask.
      name: 'steal', needs: 'any', when: function () { return !!(skin && skin.heist); },
      what: 'nick something — a word, a prop — and add it to the hoard',
      run: function () { if (!startHeist()) return 'already on a job'; }
    },
    {
      name: 'lamp', needs: 'any', gate: 'lamp', what: 'go to the light — whatever you are typing in',
      run: function () { if (!toLamp()) return 'nothing lit to go to'; }
    },
    {
      name: 'haunt', needs: 'any', when: function () { return !!(skin && skin.haunt); },
      what: 'lean on the nearest real thing — press it to straighten it',
      run: function () { if (!startHaunt()) return 'nothing near it worth disturbing'; }
    },
    {
      name: 'scrawl', needs: 'any', when: function () { return !!(skin && skin.graffiti); },
      what: 'write on your screen — press it to wipe it off',
      run: function () { if (!startGraffiti()) return 'nowhere to write'; }
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
      if (ACTIONS[i].when && !ACTIONS[i].when()) continue;
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
    if ((a.gate && !allowed(a.gate)) || (a.when && !a.when())) {
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
    // The fitting room: apply a form RIGHT NOW without touching the stored
    // choice or the on/off preference, optionally dressed for night N of its
    // seasonal window — Mascot.rehearse('menorah', 3) is three candles in
    // July. Console-only by design; a reload snaps everything back to what
    // the resolver really says.
    rehearse: function (id, day) {
      injectSkin(String(id), function (ok) {
        if (!ok) { console.warn('[Mascot] rehearse: skin "' + id + '" did not load'); return; }
        if (running) stop();
        applySkin(id);
        if (day != null) CFG.SEASONAL_DAY = Math.max(0, (day | 0) - 1);
        start();
      });
    },
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
    // …and a press is also how stolen goods are reclaimed: a coordinate test,
    // never a listener on the loot, so the same press still reaches the page.
    document.addEventListener('pointerdown', function (e) {
      track(e);
      clickLoot(e.clientX, e.clientY);
    }, { passive: true });
    document.addEventListener('pointerup', function (e) {
      releaseThrow(e.clientX, e.clientY);
    }, { passive: true });
    document.addEventListener('pointercancel', function () { aiming = null; }, { passive: true });
    window.addEventListener('resize', function () { lastScan = -1e9; });
  }
  // NOTE: boot() is called at the very BOTTOM of this file, not here — the
  // pattern the old single file needed to keep its SVG and CSS defined before
  // boot ran. The tail data is gone but the pattern stays: it costs nothing,
  // and the next person to add something below boot() will not trip over it.

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
