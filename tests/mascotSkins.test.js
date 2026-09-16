// tests/mascotSkins.test.js
//
// Smoke suite for the mascot engine + skin registry
// (public/js/mascot/engine.js and public/js/mascot/skins/*).
//
// WHY THIS EXISTS — the mascot had zero tests through two full rewrites, and
// the failure mode of a skin is invisible to every other suite: a skin that
// forgets to style `hang` renders a frozen sprite stuck to the ceiling, an SVG
// with one unclosed tag renders nothing at all, and neither throws anywhere a
// human is looking. These are the checks the engine⇄skin CONTRACT makes
// possible: every skin is data, so every skin can be audited the same way.
//
// The engine is evaluated FOR REAL in a jsdom window (no mocks of the module
// under test): its boot path runs, its register() validates, its setSkin()
// switches. The skin files are then evaluated in the same window, exactly the
// way the browser loads them, with register wrapped only to OBSERVE the defs
// on their way through.
//
// What is asserted, per skin:
//   1. the SVG parses as well-formed XML and is an <svg> of the declared geom;
//   2. the css covers every engine state the skin's `can` list permits
//      ('leave' excepted — see STATES_NEEDING_CSS), and every idle act,
//      and mentions NO data-state outside the engine's vocabulary (that last
//      one is the anti-fork rule: a skin styling `ignite` instead of `inflate`
//      is the exact mistake that turned mascot2.js into an 84KB copy);
//   3. words / lookAct refer to actions that exist.
// And for the engine:
//   4. Mascot.STATES matches the setState() call sites in the source, so the
//      published vocabulary cannot drift from the code;
//   5. skin resolution: default, stored-choice, malformed-storage, and a
//      registry-backed setSkin() round trip;
//   6. the `can` mask: register() validates its shape, the console/panel
//      repertoire shrinks to match, and the ambient entry points carry their
//      gates (asserted against the source, since the ambient paths are
//      Math.random-driven).
//
// Run:
//   npx jest tests/mascotSkins.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ENGINE_PATH = path.join(__dirname, '../public/js/mascot/engine.js');
const SKINS_DIR = path.join(__dirname, '../public/js/mascot/skins');

const ENGINE_SRC = fs.readFileSync(ENGINE_PATH, 'utf8');
const SKIN_FILES = fs.readdirSync(SKINS_DIR).filter(f => f.endsWith('.js')).sort();

// 'leave' is the walk-off: the engine glides the sprite out in its neutral
// pose, and no skin has ever styled it. Every other state a skin permits must
// appear in its css — an unstyled state is a frozen sprite.
const STATES_NEEDING_CSS = states => states.filter(s => s !== 'leave');

// The engine's non-idle action names (the idle ones come from each skin).
const BASE_ACTION_NAMES = ['walk', 'idle', 'talk', 'jump', 'fly', 'climb', 'hang', 'fall',
  'chase', 'weave', 'rappel', 'drift', 'blink', 'flip'];

/** A real window with the real engine evaluated in it.
 *  runScripts:'outside-only' is load-bearing: without it window.eval runs in
 *  the OUTER node realm, where the engine's own storage guard catches the
 *  ReferenceError and bails out exactly as designed — and Mascot never exists.
 *  jsdom also parses async, so boot() may be waiting on DOMContentLoaded;
 *  we wait with it. */
async function bootWindow({ storedSkin } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { url: 'https://app.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  if (storedSkin !== undefined) dom.window.localStorage.setItem('yc.mascot.skin', storedSkin);
  dom.window.eval(ENGINE_SRC);
  if (dom.window.document.readyState === 'loading') {
    await new Promise(res => dom.window.document.addEventListener('DOMContentLoaded', res));
  }
  return dom.window;
}

/** Boot, wrap register to observe, then evaluate every skin file for real. */
async function bootWithSkins() {
  const win = await bootWindow();
  const defs = {};
  const realRegister = win.Mascot.register;
  win.Mascot.register = def => { defs[def.id] = def; return realRegister(def); };
  for (const f of SKIN_FILES) win.eval(fs.readFileSync(path.join(SKINS_DIR, f), 'utf8'));
  win.Mascot.register = realRegister;
  return { win, defs };
}

const cfgFor = () => ({ INFLATE_MS: 0.95, POP_MS: 0.22, HOLD_MS: 900, W: 36, H: 28, FLY_HEAD: 52 });
const svgOf = def => (typeof def.svg === 'function' ? def.svg(cfgFor()) : def.svg);
const cssOf = def => (typeof def.css === 'function' ? def.css(cfgFor()) : def.css).join('\n');

describe('mascot engine', () => {
  test('boots in a bare window and exposes the API', async () => {
    const win = await bootWindow();
    expect(win.Mascot).toBeDefined();
    for (const k of ['on', 'off', 'toggle', 'out', 'do', 'list', 'debug',
      'register', 'skins', 'skin', 'setSkin', 'portrait', 'STATES']) {
      expect(typeof win.Mascot[k]).not.toBe('undefined');
    }
    expect(win.Mascot.out()).toBe(false);
  });

  test('STATES matches the setState() call sites in the source', async () => {
    // setState() is the only writer of dataset.state; 'drag' and friends all
    // pass literals, so the source IS the vocabulary. If this fails, someone
    // added or renamed a state without updating Mascot.STATES — the exact
    // drift the skins' css audits depend on catching.
    const set = new Set();
    for (const m of ENGINE_SRC.matchAll(/setState\('([a-z]+)'/g)) set.add(m[1]);
    const win = await bootWindow();
    expect([...set].sort()).toEqual([...win.Mascot.STATES].sort());
  });

  test('register() refuses a malformed skin and accepts a minimal one', async () => {
    const win = await bootWindow();
    expect(win.Mascot.register({ id: 'nope' })).toBe(false);
    expect(win.Mascot.register({
      id: 'blob', name: 'Blob', geom: { W: 10, H: 10, FLY_HEAD: 12 },
      acts: [['sit', 1]], lines: ['.'], svg: '<svg/>', css: []
    })).toBe(true);
  });

  test('skin resolution: default, stored, malformed', async () => {
    expect((await bootWindow()).Mascot.skin().id).toBe('casey');
    expect((await bootWindow({ storedSkin: JSON.stringify({ id: 'casey95', at: 1 }) })).Mascot.skin().id).toBe('casey95');
    expect((await bootWindow({ storedSkin: JSON.stringify({ id: 'ghost-of-slice-5', at: 1 }) })).Mascot.skin().id).toBe('casey');
    expect((await bootWindow({ storedSkin: '{{{' })).Mascot.skin().id).toBe('casey');
  });

  test('setSkin() switches and persists {id,at}', async () => {
    const { win } = await bootWithSkins();    // registry warm → no network path
    let answered = null;
    win.Mascot.setSkin('casey95', ok => { answered = ok; });
    expect(answered).toBe(true);
    expect(win.Mascot.skin().id).toBe('casey95');
    expect(win.Mascot.skin().words.fly).toBe('jetpack');
    const stored = JSON.parse(win.localStorage.getItem('yc.mascot.skin'));
    expect(stored.id).toBe('casey95');
    expect(typeof stored.at).toBe('number');
    // …and the picker flags the switch.
    const cur = win.Mascot.skins().filter(s => s.current).map(s => s.id);
    expect(cur).toEqual(['casey95']);
    // On/off stayed orthogonal: switching skins asked nobody to come out.
    expect(win.localStorage.getItem('yc.mascot.on')).toBe(null);
    expect(win.Mascot.out()).toBe(false);
  });

  test('the picker offers the visible forms; hidden ones stay off it', async () => {
    const skins = (await bootWindow()).Mascot.skins();
    expect(skins.map(s => s.id)).toEqual(['casey', 'casey95', 'roomba', 'ghost', 'ufo', 'snail', 'spider']);
    expect(skins.map(s => s.id)).not.toContain('menorah');   // hidden: seasonal/console only
    // §2's honesty rule: exactly the obtrusive one carries the rowdy flag.
    expect(skins.filter(s => s.rowdy).map(s => s.id)).toEqual(['spider']);
  });

  test('a hidden form still loads, applies, and marks no picker card current', async () => {
    const { win } = await bootWithSkins();      // registry warm → no network path
    let ok = null;
    win.Mascot.setSkin('menorah', v => { ok = v; });
    expect(ok).toBe(true);
    expect(win.Mascot.skin().id).toBe('menorah');
    expect(win.Mascot.skins().every(s => !s.current)).toBe(true);
  });

  test('register() validates a can mask', async () => {
    const win = await bootWindow();
    const base = { name: 'X', geom: { W: 10, H: 10, FLY_HEAD: 10 }, acts: [['sit', 1]], lines: ['.'], svg: '<svg/>', css: [] };
    const CORE = ['walk', 'idle', 'fall', 'land', 'drag', 'leave'];
    expect(win.Mascot.register({ ...base, id: 'ok-can', can: [...CORE] })).toBe(true);
    expect(win.Mascot.register({ ...base, id: 'no-core', can: ['walk', 'idle'] })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'half-hop', can: [...CORE, 'hop'] })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'half-ascent', can: [...CORE, 'inflate', 'float'] })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'full-ascent', can: [...CORE, 'inflate', 'float', 'pop'] })).toBe(true);
    expect(win.Mascot.register({ ...base, id: 'blink-no-drift', can: [...CORE, 'blink'] })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'drift-only', can: [...CORE, 'drift'] })).toBe(true);
    // …and a trail keeps its promises: spacing, a finite life, a cap, art.
    expect(win.Mascot.register({ ...base, id: 'bad-trail', trail: { every: 0, life: 6, max: 40, svg: '<svg/>' } })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'capless-trail', trail: { every: 10, life: 6, svg: '<svg/>' } })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'ok-trail', trail: { every: 10, life: 6, max: 40, svg: '<svg/>' } })).toBe(true);
    // …and a web keeps §2a's: a ring clock, a ring cap, a lifetime, a web
    // cap, a growing break radius, and a STAGE FUNCTION for its art. The
    // weave/rappel states demand the floor plan (roam) to stand on.
    const okWeb = { ringS: 3, stages: 12, life: 120, max: 3, breakR0: 8, breakDr: 4.6, svg: () => '<svg/>' };
    expect(win.Mascot.register({ ...base, id: 'ok-web2', roam: true, web: okWeb })).toBe(true);
    expect(win.Mascot.register({ ...base, id: 'stringy-web', roam: true, web: { ...okWeb, svg: '<svg/>' } })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'ringless-web', roam: true, web: { ...okWeb, ringS: 0 } })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'weave-no-web', roam: true, can: [...CORE, 'weave'] })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'weave-no-roam', web: okWeb, can: [...CORE, 'weave'] })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'rappel-no-roam', can: [...CORE, 'rappel'] })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'full-roamer', roam: true, web: okWeb, can: [...CORE, 'weave', 'rappel'] })).toBe(true);
  });

  test('a roamer crawls the floor plan, weaves until broken, rappels until cut', async () => {
    const { win } = await bootWithSkins();
    // finally-guarded live-physics test, like the trail's.
    try {
      win.Mascot.register({
        id: 'roamy', name: 'Roamy', geom: { W: 12, H: 12, FLY_HEAD: 12 },
        roam: true,
        can: ['walk', 'idle', 'fall', 'land', 'drag', 'leave', 'rappel', 'weave'],
        acts: [['rest', 1]], lookAct: 'rest', lines: ['.'], svg: '<svg/>', css: [],
        web: {
          ringS: 0.4, stages: 4, life: 30, max: 2, breakR0: 10, breakDr: 4,
          svg: (c, stage) => '<svg width="120" height="120" viewBox="0 0 120 120">' +
            '<circle cx="60" cy="60" r="' + (4 + stage * 4) + '" fill="none" stroke="#888"/></svg>'
        }
      });
      win.Mascot.setSkin('roamy');
      win.Mascot.on();
      expect(win.Mascot.out()).toBe(true);

      // 1. it MOVES with no ledges consulted — top view, the page is the floor
      const p0 = win.Mascot.debug().cat;
      await new Promise(r => setTimeout(r, 1200));
      const p1 = win.Mascot.debug().cat;
      expect(Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y)).toBeGreaterThan(4);

      // 2. weave on command; the web then GROWS on its own clock
      expect(win.Mascot.do('weave')).toBe('weave');
      const web = win.document.querySelector('#yc-mascot .yc-obj-web');
      expect(web).toBeTruthy();
      expect(web.dataset.stage).toBe('1');
      let t0 = Date.now();
      while (Date.now() - t0 < 4000 && Number(web.dataset.stage) < 2) {
        await new Promise(r => setTimeout(r, 100));
      }
      expect(Number(web.dataset.stage)).toBeGreaterThanOrEqual(2);

      // 3. §2a: the POINTER near it breaks it, and the weaver scatters
      const m = /translate3d\((-?\d+)px, ?(-?\d+)px/.exec(web.style.transform);
      win.document.dispatchEvent(new win.MouseEvent('pointermove',
        { clientX: Number(m[1]), clientY: Number(m[2]) }));
      t0 = Date.now();
      let broke = false;
      while (Date.now() - t0 < 3000 && !broke) {
        broke = web.classList.contains('yc-obj-break') || !web.isConnected;
        if (!broke) await new Promise(r => setTimeout(r, 100));
      }
      expect(broke).toBe(true);
      t0 = Date.now();
      while (Date.now() - t0 < 3000 && win.Mascot.debug().cat.state === 'weave') {
        await new Promise(r => setTimeout(r, 100));
      }
      expect(win.Mascot.debug().cat.state).not.toBe('weave');

      // 4. rappel: an engine-owned line, cut by the pointer touching it.
      // (It refuses too near the bottom edge — let the roam wander it into
      // an eligible spot.)
      t0 = Date.now();
      let started = false;
      while (Date.now() - t0 < 6000 && !started) {
        started = win.Mascot.do('rappel') === 'rappel';
        if (!started) await new Promise(r => setTimeout(r, 150));
      }
      expect(started).toBe(true);
      const thread = win.document.querySelector('#yc-mascot .yc-thread');
      expect(thread).toBeTruthy();
      await new Promise(r => setTimeout(r, 500));
      const tm = /translate3d\((-?\d+)px, ?(-?\d+)px/.exec(thread.style.transform);
      win.document.dispatchEvent(new win.MouseEvent('pointermove',
        { clientX: Number(tm[1]), clientY: Number(tm[2]) + 25 }));
      t0 = Date.now();
      let cut = false;
      while (Date.now() - t0 < 3000 && !cut) {
        cut = !thread.isConnected || thread.classList.contains('yc-thread-snap');
        if (!cut) await new Promise(r => setTimeout(r, 100));
      }
      expect(cut).toBe(true);
    } finally {
      win.Mascot.off();
      win.close();
    }
  }, 30000);

  test('the keyboard clause is present for browsers to enforce', () => {
    // Webs may grow over ANYTHING — the pointer breaks them on the way in.
    // The one path with no pointer is the keyboard, so a web over the FOCUSED
    // field breaks by itself. Layout-dependent, so jsdom cannot exercise it —
    // pin the mechanism and its single wiring instead.
    expect(ENGINE_SRC).toContain('function focusRect');
    expect((ENGINE_SRC.match(/focusRect\(\)/g) || []).length).toBe(2);   // def + its one call in breakWebs
  });

  test('a trailing form actually leaves the trail behind it', async () => {
    const { win } = await bootWithSkins();
    // finally-guarded like the gate test: this one runs real physics — the
    // snail falls in, lands on the floor, sets off walking, and the engine's
    // world-object layer should start dropping .yc-obj-trail elements inside
    // #yc-mascot. Slow pet, real frames: give it time.
    try {
      win.Mascot.setSkin('snail');
      win.Mascot.on();
      expect(win.Mascot.out()).toBe(true);
      const t0 = Date.now();
      let seen = null;
      while (Date.now() - t0 < 9000 && !seen) {
        seen = win.document.querySelector('#yc-mascot .yc-obj-trail');
        if (!seen) await new Promise(r => setTimeout(r, 150));
      }
      expect(seen).toBeTruthy();
      expect(win.getComputedStyle(seen).pointerEvents).toBe('none');
    } finally {
      win.Mascot.off();
      // teardown clears the layer with everything else
      expect(win.document.querySelectorAll('.yc-obj').length).toBe(0);
      win.close();
    }
  }, 15000);

  test('the object layer disarms even hostile markup (§2a)', async () => {
    // pointer-events INHERITS, and a child can re-enable it — so a plain
    // "none on the wrapper" is not a guarantee, and the engine's wildcard
    // !important rule is. This registers a skin whose dropping TRIES to take
    // clicks, and asserts the engine wins.
    const { win } = await bootWithSkins();
    try {
      win.Mascot.register({
        id: 'sneak', name: 'Sneak', geom: { W: 10, H: 10, FLY_HEAD: 10 },
        acts: [['sit', 1]], lines: ['.'], svg: '<svg/>', css: [],
        trail: {
          every: 8, life: 6, max: 10,
          svg: '<svg width="8" height="4"><rect width="8" height="4" style="pointer-events:auto"/></svg>'
        }
      });
      win.Mascot.setSkin('sneak');
      win.Mascot.on();
      const t0 = Date.now();
      let rect = null;
      while (Date.now() - t0 < 9000 && !rect) {
        rect = win.document.querySelector('.yc-obj-trail rect');
        if (!rect) await new Promise(r => setTimeout(r, 150));
      }
      expect(rect).toBeTruthy();
      // jsdom's cascade does not rank author-!important above inline styles,
      // so the computed value cannot be asserted here — in real browsers it
      // must win (CSS 2.1 §6.4.2). Pin the LIVE stylesheet instead: the rule
      // that disarms this rect is present on the page it is on.
      const sheet = win.document.getElementById('yc-mascot-style').textContent;
      expect(sheet).toContain('.yc-obj,.yc-obj *,.yc-thread{pointer-events:none!important}');
    } finally {
      win.Mascot.off();
      win.close();
    }
  }, 15000);

  test('a can-masked form gates the console and shrinks the repertoire', async () => {
    const { win } = await bootWithSkins();
    // finally-guarded: this test runs a REAL instance (rAF and all), and a
    // failing expect must still stop the loop and close the window, or the
    // leaked rAF keeps jest alive forever and a red test reads as a hang.
    try {
      // Casey first: the whole repertoire is on offer, and hang (needs: any)
      // takes even mid-fall.
      win.Mascot.setSkin('casey');
      win.Mascot.on();
      expect(win.Mascot.out()).toBe(true);
      const caseyList = win.Mascot.list(true);
      expect(caseyList).toEqual(
        expect.arrayContaining(['fly', 'climb', 'hang', 'jump', 'chase']));
      // …but not the noclip pair: the cat's can predates it, deliberately.
      expect(caseyList).not.toContain('drift');
      expect(caseyList).not.toContain('blink');
      expect(win.Mascot.do('hang')).toBe('hang');
      expect(win.Mascot.do('drift')).toBe(false);
      // Switch to the Roomba mid-run: setSkin restarts it, the gates shut, and
      // the panel's source of buttons no longer offers what it cannot do.
      win.Mascot.setSkin('roomba');
      expect(win.Mascot.out()).toBe(true);
      const open = win.Mascot.list(true);
      for (const gated of ['fly', 'climb', 'hang', 'jump']) {
        expect(open).not.toContain(gated);
        expect(win.Mascot.do(gated)).toBe(false);
      }
      expect(open).toContain('chase');     // chase IS in its can
      expect(open).toContain('whirr');     // and its own acts came with it
      // And the ghost gets the pair the others are denied.
      win.Mascot.setSkin('ghost');
      const spectral = win.Mascot.list(true);
      expect(spectral).toEqual(expect.arrayContaining(['drift', 'blink']));
      expect(spectral).not.toContain('climb');
      expect(win.Mascot.do('drift')).toBe('drift');
      expect(win.Mascot.do('blink')).toBe('blink');
    } finally {
      win.Mascot.off();
      win.close();
    }
  });

  test('rehearse() dresses a form live without touching any stored state', async () => {
    const { win } = await bootWithSkins();
    try {
      win.Mascot.rehearse('menorah', 3);        // registry warm → synchronous
      expect(win.Mascot.out()).toBe(true);
      expect(win.Mascot.skin().id).toBe('menorah');
      // The LIVE sprite carries night 3: shamash + three candles.
      const flames = win.document.querySelector('.yc-cat').innerHTML.match(/class="m9-flame/g);
      expect(flames.length).toBe(4);
      // …and neither the stored choice nor the on/off pref moved.
      expect(win.localStorage.getItem('yc.mascot.skin')).toBe(null);
      expect(win.localStorage.getItem('yc.mascot.on')).toBe(null);
    } finally {
      win.Mascot.off();
      win.close();
    }
  });

  test('the menorah lights one more candle per night', async () => {
    const { defs } = await bootWithSkins();
    const flames = day => (defs.menorah.svg({ SEASONAL_DAY: day }).match(/class="m9-flame/g) || []).length;
    expect(flames(0)).toBe(2);    // night 1: shamash + one
    expect(flames(3)).toBe(5);
    expect(flames(7)).toBe(9);    // night 8: the full set
    expect(flames(-1)).toBe(9);   // out of season = full dress (the portrait)
  });

  test('ambient entry points carry the can gates', () => {
    // The console refuses via each action's `gate`; the AMBIENT paths refuse
    // inside the primitives, which roll Math.random and cannot be driven from
    // a test. These counts are that contract — remove a gate and this is what
    // notices.
    const count = re => (ENGINE_SRC.match(re) || []).length;
    expect(count(/allowed\('float'\)/g)).toBe(1);   // tryFly
    expect(count(/allowed\('hop'\)/g)).toBe(1);     // tryHop
    expect(count(/allowed\('climb'\)/g)).toBe(2);   // atEdge + the hang walk
    expect(count(/allowed\('hang'\)/g)).toBe(1);    // climb-top ceiling branch
    expect(count(/allowed\('chase'\)/g)).toBe(1);   // walk's cursor-notice
    expect(count(/allowed\('drift'\)/g)).toBe(2);   // toIdle roll + airborne poke
    expect(count(/allowed\('blink'\)/g)).toBe(1);   // drift's end-of-wander roll
    expect(count(/allowed\('weave'\)/g)).toBe(1);   // toIdle roll
    expect(count(/allowed\('rappel'\)/g)).toBe(1);  // toIdle roll
  });
});

describe('seasonal resolution', () => {
  // Dates below are ground truth, cross-checked against Intl's own hebrew
  // calendar in V8 on 2026-09-15: Hanukkah 5787 first candle the evening of
  // 2026-12-04 (25 Kislev = Dec 5 civil), 5788's on 2027-12-24; Yom Kippur
  // 5787 = 2026-09-21 (10 Tishri — Intl's spelling); Tisha B'Av 5786 =
  // 2026-07-23 (9 Av).

  test('the verdict: nights, the 18:00 rule, sit-outs, quiet days', async () => {
    const win = await bootWindow();
    const S = d => win.Mascot.season(d);
    expect(S('2026-12-05T12:00:00')).toMatchObject({ id: 'menorah', sitOut: false });
    expect(S('2026-12-05T12:00:00').window).toMatchObject({ id: 'menorah', day: 1 });
    expect(S('2026-12-04T19:30:00').window).toMatchObject({ id: 'menorah', day: 1 });  // sunset-ish, not midnight
    expect(S('2026-12-04T12:00:00').window).toBe(null);                                // too early on erev
    expect(S('2026-12-12T12:00:00').window).toMatchObject({ day: 8 });
    expect(S('2026-12-13T12:00:00').window).toBe(null);                                // over
    // The solemn days sit the pet out — and still resolve the underlying
    // form, because an explicit summon that day brings that form.
    expect(S('2026-09-21T12:00:00')).toMatchObject({ id: 'casey', sitOut: true });     // Yom Kippur
    expect(S('2026-07-23T12:00:00').sitOut).toBe(true);                                // Tisha B'Av
    // An ordinary day is nobody's window.
    expect(S('2026-09-15T12:00:00')).toMatchObject({ id: 'casey', sitOut: false, window: null });
  });

  test('a choice made during a window overrides it — that window only', async () => {
    // Chose casey95 on night 2 → nights 3–8 stay casey95…
    const at = new Date('2026-12-06T20:00:00').getTime();
    let win = await bootWindow({ storedSkin: JSON.stringify({ id: 'casey95', at }) });
    expect(win.Mascot.season('2026-12-08T12:00:00')).toMatchObject({ id: 'casey95', window: null });
    // …a choice made BEFORE the window does not override it…
    const before = new Date('2026-11-01T12:00:00').getTime();
    win = await bootWindow({ storedSkin: JSON.stringify({ id: 'casey95', at: before }) });
    expect(win.Mascot.season('2026-12-08T12:00:00').id).toBe('menorah');
    // …and it never leaks into the NEXT instance: a year later, the menorah
    // forces again over the same stored record.
    win = await bootWindow({ storedSkin: JSON.stringify({ id: 'casey95', at }) });
    expect(win.Mascot.season('2027-12-26T12:00:00').id).toBe('menorah');
  });
});

describe('every registered skin honours the contract', () => {
  let win, defs, STATES;
  beforeAll(async () => {
    ({ win, defs } = await bootWithSkins());
    STATES = win.Mascot.STATES;
  });

  test('all shipped skins registered', () => {
    expect(Object.keys(defs).sort()).toEqual(['casey', 'casey95', 'ghost', 'menorah', 'roomba', 'snail', 'spider', 'ufo']);
  });

  for (const f of SKIN_FILES) {
    const id = path.basename(f, '.js');

    describe(`${f}`, () => {
      const def = () => defs[id];

      test('registered under its file name', () => {
        expect(def()).toBeDefined();
        expect(def().id).toBe(id);
      });

      test('SVG parses and matches the declared geometry', () => {
        const svg = svgOf(def());
        const doc = new win.DOMParser().parseFromString(svg, 'image/svg+xml');
        expect(doc.getElementsByTagName('parsererror').length).toBe(0);
        expect(doc.documentElement.localName).toBe('svg');
        expect(Number(doc.documentElement.getAttribute('width'))).toBe(def().geom.W);
        expect(Number(doc.documentElement.getAttribute('height'))).toBe(def().geom.H);
      });

      test('css styles every permitted state and no foreign ones', () => {
        const css = cssOf(def());
        const permitted = def().can || STATES;
        for (const s of STATES_NEEDING_CSS(permitted)) {
          expect(css).toContain(`[data-state="${s}"]`);
        }
        // The anti-fork rule: a selector for a state the engine never sets is
        // dead art at best, and at worst the old ignite/boost/cutout rename
        // creeping back in.
        for (const m of css.matchAll(/\[data-state="([^"]+)"\]/g)) {
          expect(STATES).toContain(m[1]);
        }
      });

      test('css styles every idle act, and act selectors name real acts', () => {
        const css = cssOf(def());
        const acts = def().acts.map(a => a[0]);
        for (const a of acts) expect(css).toContain(`[data-act="${a}"]`);
        for (const m of css.matchAll(/\[data-act="([^"]+)"\]/g)) {
          expect(acts).toContain(m[1]);
        }
      });

      test('acts are weighted and any opts are sane', () => {
        for (const entry of def().acts) {
          expect(typeof entry[0]).toBe('string');
          expect(entry[1]).toBeGreaterThan(0);
          if (entry[2] && entry[2].dur) expect(entry[2].dur.length).toBe(2);
          if (entry[2] && entry[2].cmdDur) expect(entry[2].cmdDur.length).toBe(2);
        }
      });

      test('lookAct and words point at actions that exist', () => {
        const acts = def().acts.map(a => a[0]);
        const known = new Set([...BASE_ACTION_NAMES, ...acts]);
        expect(acts).toContain(def().lookAct || 'look');
        for (const w of Object.keys(def().words || {})) {
          expect(known.has(w)).toBe(true);
        }
      });

      test('has lines, a name and a blurb for the picker', () => {
        expect(def().lines.length).toBeGreaterThan(0);
        expect(def().name.length).toBeGreaterThan(0);
        expect(def().blurb.length).toBeGreaterThan(0);
      });
    });
  }
});
