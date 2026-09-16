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
  'chase', 'weave', 'rappel', 'drift', 'blink', 'pursue', 'steal', 'haunt', 'lamp', 'flip'];

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
    expect(skins.map(s => s.id)).toEqual(['casey', 'casey95', 'roomba', 'ghost', 'ufo', 'snail',
      'spider', 'bat', 'goose', 'poltergeist', 'moth', 'dog']);
    expect(skins.map(s => s.id)).not.toContain('menorah');   // hidden: seasonal/console only
    // §2's honesty rule: exactly the obtrusive one carries the rowdy flag.
    expect(skins.filter(s => s.rowdy).map(s => s.id)).toEqual(['spider', 'goose', 'poltergeist']);
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
    // a perch is where a pursuit ends — it cannot exist without one…
    expect(win.Mascot.register({ ...base, id: 'perch-no-pursue', can: [...CORE, 'perch'] })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'full-hunter', can: [...CORE, 'pursue', 'perch'] })).toBe(true);
    // …but a pursuit without a perch is legal: the catch just ends in a gloat.
    expect(win.Mascot.register({ ...base, id: 'pursue-only', can: [...CORE, 'pursue'] })).toBe(true);
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
    // …and the thief's kit: heists run on the roam machinery, and an empty
    // kit would strand the prop half of every job. upright, likewise, is a
    // roam variant — without roam there is nothing to vary.
    expect(win.Mascot.register({ ...base, id: 'heist-no-roam', heist: { props: ['<svg/>'] } })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'heist-bare-kit', roam: true, heist: { props: [] } })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'heist-junk-kit', roam: true, heist: { props: ['<svg/>', 7] } })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'ok-thief', roam: true, heist: { props: ['<svg/>'] } })).toBe(true);
    // …and an errand has to end somewhere the engine knows about
    expect(win.Mascot.register({ ...base, id: 'ok-fetcher', roam: true, heist: { props: ['<svg/>'], to: 'cursor' } })).toBe(true);
    expect(win.Mascot.register({ ...base, id: 'ok-hoarder', roam: true, heist: { props: ['<svg/>'], to: 'stash' } })).toBe(true);
    expect(win.Mascot.register({ ...base, id: 'nowhere-errand', roam: true, heist: { props: ['<svg/>'], to: 'the moon' } })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'upright-no-roam', upright: true })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'ok-upright', roam: true, upright: true })).toBe(true);
    // …and the haunt kit: a ceiling, a clock, and at least one pose to strike.
    const okHaunt = { max: 3, life: 12, poses: ['rotate(-3deg)'] };
    expect(win.Mascot.register({ ...base, id: 'ok-haunter', haunt: okHaunt })).toBe(true);
    expect(win.Mascot.register({ ...base, id: 'capless-haunt', haunt: { ...okHaunt, max: 0 } })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'eternal-haunt', haunt: { ...okHaunt, life: 0 } })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'poseless-haunt', haunt: { ...okHaunt, poses: [] } })).toBe(false);
    expect(win.Mascot.register({ ...base, id: 'junk-poses', haunt: { ...okHaunt, poses: ['rotate(1deg)', 7] } })).toBe(false);
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
          ringS: 0.4, stages: 8, life: 30, max: 4, breakR0: 10, breakDr: 4,
          svg: (c, stage) => '<svg width="120" height="120" viewBox="0 0 120 120">' +
            '<circle cx="60" cy="60" r="' + (4 + stage * 4) + '" fill="none" stroke="#888"/></svg>'
        }
      });
      win.Mascot.setSkin('roamy');
      win.Mascot.on();
      expect(win.Mascot.out()).toBe(true);

      // 1. it MOVES with no ledges consulted — top view, the page is the floor.
      // POLLED, not sampled across a fixed window: the roam cadence is
      // deliberately scurry-and-freeze (pauses to 0.8s, and a reached target
      // means an idle act of up to 4.5s), so any fixed window can legitimately
      // contain no travel at all — which is exactly how this flaked twice
      // under a loaded full-suite run. A roamer that cannot manage 4px in
      // eight seconds is broken; one that is mid-freeze is not.
      const p0 = win.Mascot.debug().cat;
      let travelled = 0, tMove = Date.now();
      while (Date.now() - tMove < 8000 && travelled <= 4) {
        await new Promise(r => setTimeout(r, 120));
        const p1 = win.Mascot.debug().cat;
        travelled = Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y);
      }
      expect(travelled).toBeGreaterThan(4);

      // 2. weave on command; the web then GROWS on its own clock
      expect(win.Mascot.do('weave')).toBe('weave');
      const web = win.document.querySelector('#yc-mascot .yc-obj-web');
      expect(web).toBeTruthy();
      expect(web.dataset.stage).toBe('1');
      // …and it rides ON the web while it works: orbiting the rim, not
      // pinned under the centre.
      await new Promise(r => setTimeout(r, 350));
      const wm = /translate3d\((-?\d+)px, ?(-?\d+)px/.exec(web.style.transform);
      const rider = win.Mascot.debug().cat;
      expect(Math.hypot(rider.x - Number(wm[1]), rider.y - Number(wm[2]))).toBeGreaterThan(3);
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
      // toRappel() refuses within 120px of the bottom — there is no page left
      // to descend. Waiting for the wander to leave that band is a BET, and
      // one this test lost about one run in eight: the cadence can sit out a
      // multi-second idle down there. So put it where the trick is legal, by
      // the same gesture a person would use — pick it up and set it down. The
      // second pointermove to the same spot zeroes the throw velocity, so it
      // is placed rather than flung.
      const catEl = win.document.querySelector('.yc-cat');
      const dropX = Math.round(win.innerWidth / 2), dropY = 150;
      catEl.dispatchEvent(new win.MouseEvent('pointerdown',
        { clientX: win.Mascot.debug().cat.x, clientY: win.Mascot.debug().cat.y, bubbles: true }));
      catEl.dispatchEvent(new win.MouseEvent('pointermove',
        { clientX: dropX, clientY: dropY, bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
      catEl.dispatchEvent(new win.MouseEvent('pointermove',
        { clientX: dropX, clientY: dropY, bubbles: true }));
      catEl.dispatchEvent(new win.MouseEvent('pointerup',
        { clientX: dropX, clientY: dropY, bubbles: true }));
      await new Promise(r => setTimeout(r, 400));      // let the set-down settle
      expect(win.Mascot.debug().cat.y).toBeLessThan(win.innerHeight - 120);

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

  test('a finished web starts the next one at overlap — and breaks can ripple', async () => {
    const { win } = await bootWithSkins();
    try {
      win.Mascot.register({
        id: 'tiler', name: 'Tiler', geom: { W: 12, H: 12, FLY_HEAD: 12 },
        roam: true,
        can: ['walk', 'idle', 'fall', 'land', 'drag', 'leave', 'weave'],
        acts: [['rest', 1]], lookAct: 'rest', lines: ['.'], svg: '<svg/>', css: [],
        web: {
          ringS: 0.3, stages: 2, life: 60, max: 6, breakR0: 10, breakDr: 4,
          svg: (c, stage) => '<svg width="120" height="120" viewBox="0 0 120 120">' +
            '<circle cx="60" cy="60" r="' + (4 + stage * 4) + '" fill="none" stroke="#888"/></svg>'
        }
      });
      win.Mascot.setSkin('tiler');
      win.Mascot.on();
      expect(win.Mascot.do('weave')).toBe('weave');
      // The web finishes in ~0.6s; the tiler then leaves it standing, walks
      // to a plot at slight overlap, and breaks ground on the next.
      let t0 = Date.now();
      let webs = [];
      while (Date.now() - t0 < 8000 && webs.length < 2) {
        webs = [...win.document.querySelectorAll('#yc-mascot .yc-obj-web')];
        if (webs.length < 2) await new Promise(r => setTimeout(r, 120));
      }
      expect(webs.length).toBeGreaterThanOrEqual(2);
      const c = webs.slice(0, 2).map(w => {
        const m = /translate3d\((-?\d+)px, ?(-?\d+)px/.exec(w.style.transform);
        return { x: Number(m[1]), y: Number(m[2]) };
      });
      const d = Math.hypot(c[0].x - c[1].x, c[0].y - c[1].y);
      // finished radius = 10 + 2*4 = 18 → planned spacing 1.7R ≈ 31: apart,
      // but overlapping (< R+R = 36, with slop for the bounds clamp)
      expect(d).toBeGreaterThan(12);
      expect(d).toBeLessThan(40);
      // The ripple: force the cascade roll and break web #1 — the overlapping
      // neighbour goes with it, a beat later.
      const realRandom = win.Math.random;
      win.Math.random = () => 0.1;
      win.document.dispatchEvent(new win.MouseEvent('pointermove', { clientX: c[0].x, clientY: c[0].y }));
      t0 = Date.now();
      let bothGone = false;
      while (Date.now() - t0 < 4000 && !bothGone) {
        bothGone = webs.slice(0, 2).every(w =>
          !w.isConnected || w.classList.contains('yc-obj-break'));
        if (!bothGone) await new Promise(r => setTimeout(r, 100));
      }
      win.Math.random = realRandom;
      expect(bothGone).toBe(true);
    } finally {
      win.Mascot.off();
      win.close();
    }
  }, 25000);

  test('the keyboard clause is present for browsers to enforce', () => {
    // Webs may grow over ANYTHING — the pointer breaks them on the way in.
    // The one path with no pointer is the keyboard, so a web over the FOCUSED
    // field breaks by itself. Layout-dependent, so jsdom cannot exercise it —
    // pin the mechanism and its single wiring instead.
    expect(ENGINE_SRC).toContain('function focusRect');
    // Pin the WIRING, not a global count: focusRect has a second legitimate
    // caller now (the moth's lamp is the same knowledge turned around), so
    // what matters is that breakWebs still asks it, on its throttle.
    const breakWebsSrc = ENGINE_SRC.slice(
      ENGINE_SRC.indexOf('function breakWebs'),
      ENGINE_SRC.indexOf('function cascadeFrom'));
    expect(breakWebsSrc).toContain('fr = focusRect();');
    expect(breakWebsSrc).toContain('nextFocusCheck = clock + 0.8;');
  });

  test('a stolen word is a copy, text only — the mechanism, pinned', () => {
    // The word heist reads the page and builds its copy through textContent
    // on BOTH sides, so markup can never ride along and the page is never
    // written to. Element rects are what pick the target, and jsdom has
    // none — so like the keyboard clause, the mechanism is pinned in source
    // and browsers exercise it: the copy is born from textContent…
    expect(ENGINE_SRC).toMatch(/span\.textContent = word/);
    // …and the heist machinery never writes into a document other than its
    // own loot elements: the only innerHTML between findWordTarget and
    // dropLoot is the skin-authored prop svg and the carried→loot handoff.
    const heistSrc = ENGINE_SRC.slice(
      ENGINE_SRC.indexOf('function findWordTarget'),
      ENGINE_SRC.indexOf('function dropLoot'));
    expect((heistSrc.match(/innerHTML/g) || []).length).toBe(1);         // the prop svg
    expect(heistSrc).toContain('el.innerHTML = svg');
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

  test('the pursuit never gives up, and the catch is a perch', async () => {
    const { win } = await bootWithSkins();
    try {
      win.Mascot.setSkin('bat');
      win.Mascot.on();
      expect(win.Mascot.out()).toBe(true);

      // Before any pointer has been seen there is nothing to hunt — the
      // action refuses (run() returns a why-string, so do() reports false).
      expect(win.Mascot.do('pursue')).toBe(false);

      // Show it a cursor ~120px from wherever it spawned, then send it.
      const at = win.Mascot.debug().cat;
      const mx = Math.max(30, Math.min(win.innerWidth - 30, at.x + 120));
      const my = Math.max(30, Math.min(win.innerHeight - 60, at.y - 80));
      win.document.dispatchEvent(new win.MouseEvent('pointermove', { clientX: mx, clientY: my }));
      expect(win.Mascot.do('pursue')).toBe('pursue');
      expect(win.Mascot.debug().cat.state).toBe('pursue');

      // The catch: homing flight ends within 14px of the cursor, and a form
      // with 'perch' swings under it and hangs — pinned at the pointer, feet
      // up (the anchor sits one sprite-height below, per the engine).
      let t0 = Date.now();
      while (Date.now() - t0 < 5000 && win.Mascot.debug().cat.state !== 'perch') {
        await new Promise(r => setTimeout(r, 80));
      }
      const hung = win.Mascot.debug().cat;
      expect(hung.state).toBe('perch');
      expect(Math.abs(hung.x - mx)).toBeLessThan(2);
      expect(Math.abs(hung.y - (my + 16 + 2))).toBeLessThan(2);   // bat geom.H = 16

      // The branch flies off (>60px) — the bat simply resumes the hunt.
      win.document.dispatchEvent(new win.MouseEvent('pointermove',
        { clientX: Math.max(30, mx - 200), clientY: my }));
      t0 = Date.now();
      while (Date.now() - t0 < 3000 && win.Mascot.debug().cat.state !== 'pursue') {
        await new Promise(r => setTimeout(r, 80));
      }
      expect(win.Mascot.debug().cat.state).toBe('pursue');
    } finally {
      win.Mascot.off();
      win.close();
    }
  }, 20000);

  test('a thief steals on command and the loot lands in the corner hoard', async () => {
    const { win } = await bootWithSkins();
    try {
      // Forms without the gear never even see the button: the steal action
      // carries a `when`, so a cat's panel has no steal to apologise for.
      win.Mascot.setSkin('casey');
      win.Mascot.on();
      expect(win.Mascot.out()).toBe(true);
      expect(win.Mascot.list(true)).not.toContain('steal');
      expect(win.Mascot.do('steal')).toBe(false);

      // A fast test thief, so the two walk legs fit a test's patience.
      // (jsdom has no element rects, so the word target always comes up
      // empty and the prop path runs — deterministically, which suits.)
      win.Mascot.register({
        id: 'grabby', name: 'Grabby', geom: { W: 12, H: 12, FLY_HEAD: 12 },
        roam: true, upright: true,
        tune: { WALK: 420, HEIST_CHANCE: 0 },      // command-driven only
        heist: { props: ['<svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" fill="#888"/></svg>'] },
        acts: [['sit', 1]], lookAct: 'sit', lines: ['.'], svg: '<svg/>', css: []
      });
      win.Mascot.setSkin('grabby');
      expect(win.Mascot.out()).toBe(true);
      expect(win.Mascot.list(true)).toContain('steal');
      expect(win.Mascot.do('steal')).toBe('steal');

      // Leg one: it walks to the spot and the loot appears in the beak —
      // and, the upright contract, it walks WITHOUT rotating to its heading.
      let t0 = Date.now();
      let carrying = false, maxRot = 0;
      const catEl = win.document.querySelector('.yc-cat');
      const rotOf = () => Math.abs(win.Mascot.debug().cat.rot || 0);
      while (Date.now() - t0 < 8000 && !carrying) {
        maxRot = Math.max(maxRot, rotOf());
        carrying = catEl.dataset.carry === '1';
        if (!carrying) await new Promise(r => setTimeout(r, 100));
      }
      expect(carrying).toBe(true);
      expect(win.document.querySelector('#yc-mascot .yc-carried')).toBeTruthy();

      // Leg two: the hoard. The loot object lands by a bottom corner, the
      // beak is empty again, and — the .yc-obj contract — it can't be clicked.
      t0 = Date.now();
      let loot = null;
      while (Date.now() - t0 < 8000 && !loot) {
        maxRot = Math.max(maxRot, rotOf());
        loot = win.document.querySelector('#yc-mascot .yc-obj-loot');
        if (!loot) await new Promise(r => setTimeout(r, 100));
      }
      expect(maxRot).toBeLessThan(1);
      expect(loot).toBeTruthy();
      const lm = /translate3d\((-?\d+)px, ?(-?\d+)px/.exec(loot.style.transform);
      const lx = Number(lm[1]), ly = Number(lm[2]);
      const nearLeft = Math.abs(lx - 34) < 60;
      const nearRight = Math.abs(lx - (win.innerWidth - 34)) < 60;
      expect(nearLeft || nearRight).toBe(true);
      expect(Math.abs(ly - (win.innerHeight - 26))).toBeLessThan(45);
      expect(catEl.hasAttribute('data-carry')).toBe(false);
      expect(win.document.querySelector('#yc-mascot .yc-carried')).toBe(null);
    } finally {
      win.Mascot.off();
      win.close();
    }
  }, 25000);

  test('a real steal takes the icon, and a click gives it back', async () => {
    const { win } = await bootWithSkins();
    try {
      // jsdom has no layout, so the icon hunt (which needs real rects) would
      // never find anything. Give ONE planted icon a rect of its own — a
      // surgical double, so scan() and everything else still see jsdom's
      // usual zeros.
      const icon = win.document.createElement('i');
      icon.className = 'fa-solid fa-landmark';
      win.document.body.appendChild(icon);
      const rect = { left: 300, top: 300, right: 316, bottom: 316, width: 16, height: 16, x: 300, y: 300 };
      Object.defineProperty(icon, 'getBoundingClientRect', { value: () => rect });
      Object.defineProperty(icon, 'getClientRects', { value: () => [rect] });

      win.Mascot.register({
        id: 'magpie', name: 'Magpie', geom: { W: 12, H: 12, FLY_HEAD: 12 },
        roam: true, upright: true,
        tune: { WALK: 420, HEIST_CHANCE: 0 },
        heist: { props: ['<svg width="10" height="10"><rect width="10" height="10"/></svg>'] },
        acts: [['sit', 1]], lookAct: 'sit', lines: ['.'], svg: '<svg/>', css: []
      });
      win.Mascot.setSkin('magpie');
      win.Mascot.on();
      expect(win.Mascot.out()).toBe(true);

      // Pin the roll ONLY across target selection (r < 0.45 → icon first);
      // the physics afterwards get their real randomness back.
      const realRandom = win.Math.random;
      win.Math.random = () => 0.1;
      expect(win.Mascot.do('steal')).toBe('steal');
      win.Math.random = realRandom;

      // Leg one, the theft: the page's icon goes invisible — by OPACITY, so
      // it is still laid out and still able to take the click it may itself
      // be the target of (§2: visual, never input).
      let t0 = Date.now();
      while (Date.now() - t0 < 8000 && icon.style.opacity !== '0') {
        await new Promise(r => setTimeout(r, 80));
      }
      expect(icon.style.opacity).toBe('0');
      // …and what she is carrying is a REBUILT <i> — FA's own class tokens and
      // nothing else crossed over from the page.
      const beak = win.document.querySelector('#yc-mascot .yc-carried i');
      expect(beak).toBeTruthy();
      expect(beak.className).toBe('fa-solid fa-landmark');
      expect(beak.attributes.length).toBeLessThanOrEqual(2);      // class, maybe style

      // Leg two: it reaches the hoard, still missing from the page.
      t0 = Date.now();
      let loot = null;
      while (Date.now() - t0 < 8000 && !loot) {
        loot = win.document.querySelector('#yc-mascot .yc-obj-loot');
        if (!loot) await new Promise(r => setTimeout(r, 80));
      }
      expect(loot).toBeTruthy();
      expect(icon.style.opacity).toBe('0');
      const lm = /translate3d\((-?\d+)px, ?(-?\d+)px/.exec(loot.style.transform);

      // THE UNDO: press on it. No listener on the loot — a coordinate test,
      // so the very same press still reaches whatever sits underneath.
      win.document.dispatchEvent(new win.MouseEvent('pointerdown',
        { clientX: Number(lm[1]), clientY: Number(lm[2]) }));
      expect(loot.classList.contains('yc-obj-return')).toBe(true);   // it flies home…
      t0 = Date.now();
      while (Date.now() - t0 < 3000 && loot.isConnected) {
        await new Promise(r => setTimeout(r, 80));
      }
      expect(loot.isConnected).toBe(false);
      expect(icon.style.opacity).toBe('');        // …and the page has it back

      // And it is a CYCLE, not a one-shot: the restore has to leave the icon
      // exactly as stealable as it was, or a returned icon quietly becomes
      // untouchable — the same bookkeeping slip that, missed the other way,
      // leaves one invisible forever.
      win.Math.random = () => 0.1;
      expect(win.Mascot.do('steal')).toBe('steal');
      win.Math.random = realRandom;
      t0 = Date.now();
      while (Date.now() - t0 < 8000 && icon.style.opacity !== '0') {
        await new Promise(r => setTimeout(r, 80));
      }
      expect(icon.style.opacity).toBe('0');
    } finally {
      win.Mascot.off();
      win.close();
    }
  }, 25000);

  test('every exit returns what was stolen — teardown included', async () => {
    const { win } = await bootWithSkins();
    let icon;
    try {
      icon = win.document.createElement('i');
      icon.className = 'fa-solid fa-gavel';
      win.document.body.appendChild(icon);
      const rect = { left: 260, top: 260, right: 276, bottom: 276, width: 16, height: 16, x: 260, y: 260 };
      Object.defineProperty(icon, 'getBoundingClientRect', { value: () => rect });
      Object.defineProperty(icon, 'getClientRects', { value: () => [rect] });

      win.Mascot.register({
        id: 'magpie2', name: 'Magpie2', geom: { W: 12, H: 12, FLY_HEAD: 12 },
        roam: true, upright: true,
        tune: { WALK: 420, HEIST_CHANCE: 0 },
        heist: { props: ['<svg width="10" height="10"><rect width="10" height="10"/></svg>'] },
        acts: [['sit', 1]], lookAct: 'sit', lines: ['.'], svg: '<svg/>', css: []
      });
      win.Mascot.setSkin('magpie2');
      win.Mascot.on();
      const realRandom = win.Math.random;
      win.Math.random = () => 0.1;
      expect(win.Mascot.do('steal')).toBe('steal');
      win.Math.random = realRandom;

      const t0 = Date.now();
      while (Date.now() - t0 < 8000 && icon.style.opacity !== '0') {
        await new Promise(r => setTimeout(r, 80));
      }
      expect(icon.style.opacity).toBe('0');
    } finally {
      // Sent away mid-heist — carrying it, or with it already in the corner.
      // Either way the page is whole again the moment she is gone.
      win.Mascot.off();
      expect(icon.style.opacity).toBe('');
      expect(win.document.querySelectorAll('#yc-mascot .yc-obj').length).toBe(0);
      win.close();
    }
  }, 20000);

  test('a haunt leaves the page crooked — and every exit straightens it', async () => {
    const { win } = await bootWithSkins();
    let victim;
    try {
      // Same surgical rect double as the icon steal: jsdom has no layout, so
      // one planted element is given a rect of its own and everything else
      // keeps jsdom's zeros.
      victim = win.document.createElement('button');
      victim.textContent = 'File the thing';
      // a transform the PAGE owns, which the haunt must build on rather than
      // overwrite — and hand back untouched when it lets go
      victim.style.transform = 'translateX(3px)';
      win.document.body.appendChild(victim);
      const rect = { left: 400, top: 300, right: 520, bottom: 336, width: 120, height: 36, x: 400, y: 300 };
      Object.defineProperty(victim, 'getBoundingClientRect', { value: () => rect });
      Object.defineProperty(victim, 'getClientRects', { value: () => [rect] });

      win.Mascot.setSkin('poltergeist');
      win.Mascot.on();
      expect(win.Mascot.out()).toBe(true);
      // A form without the gear never sees the button…
      expect(win.Mascot.list(true)).toContain('haunt');

      expect(win.Mascot.do('haunt')).toBe('haunt');
      // TRANSFORM, not a layout property: hit-testing follows a transform, so
      // the button is still clickable exactly where it now looks.
      expect(victim.style.transform).toMatch(/rotate|skew|scale/);
      expect(victim.style.transform).toContain('translateX(3px)');   // the page's own, kept
      expect(victim.classList.contains('yc-haunted')).toBe(true);
      expect(victim.style.display).toBe('');
      expect(victim.style.position).toBe('');

      // THE UNDO: press the crooked thing. A coordinate test again — no
      // listener on the victim, so the press still does its normal job.
      win.document.dispatchEvent(new win.MouseEvent('pointerdown',
        { clientX: 460, clientY: 318 }));
      expect(victim.style.transform).toBe('translateX(3px)');         // exactly what it found
      expect(victim.classList.contains('yc-haunted')).toBe(false);

      // A press somewhere else leaves it alone.
      expect(win.Mascot.do('haunt')).toBe('haunt');
      expect(victim.style.transform).not.toBe('translateX(3px)');
      win.document.dispatchEvent(new win.MouseEvent('pointerdown',
        { clientX: 50, clientY: 50 }));
      expect(victim.style.transform).not.toBe('translateX(3px)');
    } finally {
      // …and send-away straightens whatever is still leaning.
      win.Mascot.off();
      expect(victim.style.transform).toBe('translateX(3px)');
      expect(victim.classList.contains('yc-haunted')).toBe(false);
      win.close();
    }
  }, 20000);

  test('a haunt restores exactly what it found, and respects its ceiling', async () => {
    const { win } = await bootWithSkins();
    const made = [];
    try {
      // Four candidates, one of which already carries an inline transform of
      // its own — the page's, not ours, and it has to survive the round trip.
      for (let i = 0; i < 4; i++) {
        const el = win.document.createElement('button');
        win.document.body.appendChild(el);
        const r = { left: 100 + i * 130, top: 300, right: 220 + i * 130, bottom: 336,
          width: 120, height: 36, x: 100 + i * 130, y: 300 };
        Object.defineProperty(el, 'getBoundingClientRect', { value: () => r });
        Object.defineProperty(el, 'getClientRects', { value: () => [r] });
        made.push(el);
      }
      made[0].style.transform = 'translateX(3px)';   // the page's own

      win.Mascot.setSkin('poltergeist');
      win.Mascot.on();

      // max is 3: the fourth request finds nothing left it is allowed to touch.
      expect(win.Mascot.do('haunt')).toBe('haunt');
      expect(win.Mascot.do('haunt')).toBe('haunt');
      expect(win.Mascot.do('haunt')).toBe('haunt');
      expect(win.Mascot.do('haunt')).toBe(false);
      expect(made.filter(e => e.classList.contains('yc-haunted')).length).toBe(3);

    } finally {
      win.Mascot.off();
      for (const el of made) expect(el.classList.contains('yc-haunted')).toBe(false);
      expect(made[0].style.transform).toBe('translateX(3px)');   // exactly what it found
      win.close();
    }
  }, 20000);

  test('the lamp is the focused field — and it is never sat on', async () => {
    const { win } = await bootWithSkins();
    try {
      // Two fields with rects of their own (jsdom has no layout). The moth
      // should take whichever is FOCUSED, and move when the focus does.
      const mk = (x, y, w, h) => {
        const el = win.document.createElement('input');
        win.document.body.appendChild(el);
        const r = { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y };
        Object.defineProperty(el, 'getBoundingClientRect', { value: () => r });
        Object.defineProperty(el, 'getClientRects', { value: () => [r] });
        return { el, r };
      };
      win.Mascot.setSkin('moth');
      win.Mascot.on();
      expect(win.Mascot.out()).toBe(true);

      // Nothing lit at all yet: no focused field, and nothing with a
      // background bright enough to stand in for one. It REFUSES rather than
      // inventing somewhere to go.
      expect(win.Mascot.do('lamp')).toBe(false);
      expect(win.Mascot.debug().cat.state).not.toBe('lamp');

      const one = mk(120, 140, 220, 34);     // wide and short: the shape that
      const two = mk(600, 470, 220, 34);     // makes a naive orbit dip inside

      // THE BOX IT IS ALREADY STANDING IN. Focus a field centred on the moth
      // itself: it begins the state inside the lit box, so the guarantee has
      // to be enforced on the very first frame rather than merely aimed at.
      // Wait for it to arrive first — every non-roam form drops in from off
      // the top of the window, and a box built around y=-40 is no test at all.
      let here = win.Mascot.debug().cat, tw = Date.now();
      while (Date.now() - tw < 9000 && !(here.y > 40 && here.y < win.innerHeight - 20)) {
        await new Promise(res => setTimeout(res, 80));
        here = win.Mascot.debug().cat;
      }
      expect(here.y).toBeGreaterThan(40);
      const onTop = mk(Math.round(here.x) - 120, Math.round(here.y) - 60, 240, 120);
      onTop.el.focus();
      expect(win.Mascot.do('lamp')).toBe('lamp');
      expect(win.Mascot.debug().cat.state).toBe('lamp');
      const clear = (p, r) =>
        p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom;
      let t1 = Date.now();
      while (Date.now() - t1 < 700) {
        await new Promise(res => setTimeout(res, 20));
        expect(clear(win.Mascot.debug().cat, onTop.r)).toBe(true);
      }
      onTop.el.remove();

      one.el.focus();
      expect(win.Mascot.do('lamp')).toBe('lamp');
      expect(win.Mascot.debug().cat.state).toBe('lamp');

      // It closes on the focused field and then ORBITS it — and across the
      // whole orbit it is never inside the box. That is the §2 promise for
      // this form: a moth sitting on the text you are typing is obstruction.
      let near = 0, t0 = Date.now();
      while (Date.now() - t0 < 9000) {
        await new Promise(res => setTimeout(res, 60));
        const p = win.Mascot.debug().cat;
        expect(clear(p, one.r)).toBe(true);           // never on the text
        const dx = p.x - (one.r.left + 110), dy = p.y - (one.r.top + 17);
        if (Math.sqrt(dx * dx + dy * dy) < 150) near++;
        if (near > 6) break;
      }
      expect(near).toBeGreaterThan(6);                  // it did arrive

      // Tab to the other field: the light moved, so the moth follows it.
      two.el.focus();
      let arrived = false;
      t0 = Date.now();
      while (Date.now() - t0 < 9000 && !arrived) {
        await new Promise(res => setTimeout(res, 60));
        const p = win.Mascot.debug().cat;
        expect(clear(p, two.r)).toBe(true);
        const dx = p.x - (two.r.left + 110), dy = p.y - (two.r.top + 17);
        arrived = Math.sqrt(dx * dx + dy * dy) < 150;
      }
      expect(arrived).toBe(true);
    } finally {
      win.Mascot.off();
      win.close();
    }
  }, 30000);

  test('a fetcher with no cursor to bring it to uses its own corner', async () => {
    // The delivery point is YOU, and before the first pointer event there is
    // no you. Without the guard the ball goes to (-1, 15) — the top-left
    // corner of nothing — instead of falling back to the hoard.
    const { win } = await bootWithSkins();
    try {
      win.Mascot.register({
        id: 'retriever0', name: 'Retriever0', geom: { W: 12, H: 12, FLY_HEAD: 12 },
        roam: true, upright: true,
        tune: { WALK: 420, HEIST_CHANCE: 0 },
        heist: { to: 'cursor', props: ['<svg width="10" height="10"><circle cx="5" cy="5" r="5"/></svg>'] },
        acts: [['sit', 1]], lookAct: 'sit', lines: ['.'], svg: '<svg/>', css: []
      });
      win.Mascot.setSkin('retriever0');
      win.Mascot.on();
      expect(win.Mascot.do('steal')).toBe('steal');      // no pointermove, ever

      let t0 = Date.now(), ball = null;
      while (Date.now() - t0 < 9000 && !ball) {
        await new Promise(r => setTimeout(r, 80));
        ball = win.document.querySelector('#yc-mascot .yc-obj-loot');
      }
      expect(ball).toBeTruthy();
      const m = /translate3d\((-?\d+)px, ?(-?\d+)px/.exec(ball.style.transform);
      const bx = Number(m[1]), by = Number(m[2]);
      expect(by).toBeGreaterThan(win.innerHeight - 90);                 // down at the floor…
      expect(Math.min(bx, win.innerWidth - bx)).toBeLessThan(90);       // …and off to one side
    } finally {
      win.Mascot.off();
      win.close();
    }
  }, 20000);

  test('a fetcher brings it to YOU — and to wherever you moved to', async () => {
    const { win } = await bootWithSkins();
    try {
      // Same errand machinery as the goose, one field different.
      win.Mascot.register({
        id: 'retriever', name: 'Retriever', geom: { W: 12, H: 12, FLY_HEAD: 12 },
        roam: true, upright: true,
        tune: { WALK: 420, HEIST_CHANCE: 0 },
        heist: { to: 'cursor', props: ['<svg width="10" height="10"><circle cx="5" cy="5" r="5"/></svg>'] },
        acts: [['sit', 1]], lookAct: 'sit', lines: ['.'], svg: '<svg/>', css: []
      });
      win.Mascot.setSkin('retriever');
      win.Mascot.on();
      expect(win.Mascot.out()).toBe(true);

      // Tell it where the cursor is, then send it.
      win.document.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 200, clientY: 200 }));
      expect(win.Mascot.do('steal')).toBe('steal');

      const catEl = win.document.querySelector('.yc-cat');
      let t0 = Date.now();
      while (Date.now() - t0 < 8000 && catEl.dataset.carry !== '1') {
        await new Promise(r => setTimeout(r, 80));
      }
      expect(catEl.dataset.carry).toBe('1');

      // MID-TROT, the cursor moves. The delivery is re-aimed every frame, so
      // the ball should arrive at the NEW place, not the old one.
      win.document.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 780, clientY: 520 }));

      t0 = Date.now();
      let ball = null;
      while (Date.now() - t0 < 9000 && !ball) {
        await new Promise(r => setTimeout(r, 80));
        ball = win.document.querySelector('#yc-mascot .yc-obj-loot');
      }
      expect(ball).toBeTruthy();
      const bm = /translate3d\((-?\d+)px, ?(-?\d+)px/.exec(ball.style.transform);
      const bx = Number(bm[1]), by = Number(bm[2]);
      // at your feet, where you are now…
      expect(Math.hypot(bx - 780, by - 536)).toBeLessThan(60);
      // …and emphatically not in a corner, which is where the other ending is
      expect(Math.hypot(bx - 200, by - 216)).toBeGreaterThan(200);
      expect(catEl.hasAttribute('data-carry')).toBe(false);

      // And asked again it goes for THAT BALL rather than making another, so
      // the floor does not slowly fill with tennis balls.
      expect(win.Mascot.do('steal')).toBe('steal');
      t0 = Date.now();
      while (Date.now() - t0 < 8000 && catEl.dataset.carry !== '1') {
        await new Promise(r => setTimeout(r, 80));
      }
      expect(catEl.dataset.carry).toBe('1');
      expect(win.document.querySelectorAll('#yc-mascot .yc-obj-loot').length).toBe(0);
    } finally {
      win.Mascot.off();
      win.close();
    }
  }, 30000);

  test('ambient entry points carry the can gates', () => {
    // The console refuses via each action's `gate`; the AMBIENT paths refuse
    // inside the primitives, which roll Math.random and cannot be driven from
    // a test. These counts are that contract — remove a gate and this is what
    // notices.
    const count = re => (ENGINE_SRC.match(re) || []).length;
    expect(count(/allowed\('float'\)/g)).toBe(1);   // tryFly
    expect(count(/allowed\('hop'\)/g)).toBe(1);     // tryHop
    expect(count(/allowed\('climb'\)/g)).toBe(2);   // atEdge + the hang walk
    expect(count(/allowed\('hang'\)/g)).toBe(2);    // climb-top branch + drift's roost run
    expect(count(/allowed\('chase'\)/g)).toBe(1);   // walk's cursor-notice
    expect(count(/allowed\('drift'\)/g)).toBe(4);   // toIdle roll + airborne poke + the lamp's two exits
    expect(count(/allowed\('blink'\)/g)).toBe(1);   // drift's end-of-wander roll
    expect(count(/allowed\('weave'\)/g)).toBe(1);   // toIdle roll
    expect(count(/allowed\('rappel'\)/g)).toBe(1);  // toIdle roll
    expect(count(/allowed\('pursue'\)/g)).toBe(1);  // toIdle roll
    expect(count(/allowed\('perch'\)/g)).toBe(1);   // the catch, inside pursue
    // the heist gates on the GEAR rather than a state, so its ambient entry
    // is pinned the same way by its one chance roll
    expect(count(/Math\.random\(\) < CFG\.HEIST_CHANCE/g)).toBe(1);   // toIdle roll
    expect(count(/Math\.random\(\) < CFG\.HAUNT_CHANCE/g)).toBe(1);   // toIdle roll
    expect(count(/allowed\('lamp'\)/g)).toBe(1);   // toIdle roll
    // A real steal is undone from exactly ONE place — the door every loot
    // object leaves by. More than one call site here means some exit has
    // grown its own copy, which is how a page ends up permanently missing
    // an icon.
    expect(count(/\.take\.restore\(\)/g)).toBe(1);                    // inside removeObj
    expect(ENGINE_SRC).toMatch(/function removeObj[\s\S]{0,400}\.take\.restore\(\)/);
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
    expect(Object.keys(defs).sort()).toEqual(['bat', 'casey', 'casey95', 'dog', 'ghost', 'goose',
      'menorah', 'moth', 'poltergeist', 'roomba', 'snail', 'spider', 'ufo']);
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
