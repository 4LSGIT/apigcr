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
//      registry-backed setSkin() round trip.
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
const BASE_ACTION_NAMES = ['walk', 'idle', 'talk', 'jump', 'fly', 'climb', 'hang', 'fall', 'chase', 'flip'];

/** A real window with the real engine evaluated in it.
 *  runScripts:'outside-only' is load-bearing: without it window.eval runs in
 *  the OUTER node realm, where the engine's own storage guard catches the
 *  ReferenceError and bails out exactly as designed — and Mascot never exists.
 *  jsdom also parses async, so boot() may be waiting on DOMContentLoaded;
 *  we wait with it. */
async function bootWindow({ storedSkin } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { url: 'https://app.test/', runScripts: 'outside-only' });
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

  test('the manifest offers casey and casey95, casey first', async () => {
    const ids = (await bootWindow()).Mascot.skins().map(s => s.id);
    expect(ids).toEqual(['casey', 'casey95']);
  });
});

describe('every registered skin honours the contract', () => {
  let win, defs, STATES;
  beforeAll(async () => {
    ({ win, defs } = await bootWithSkins());
    STATES = win.Mascot.STATES;
  });

  test('both shipped skins registered', () => {
    expect(Object.keys(defs).sort()).toEqual(['casey', 'casey95']);
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
