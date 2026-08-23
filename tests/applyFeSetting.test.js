/**
 * tests/applyFeSetting.test.js
 *
 * Executes public/scripts.js FOR REAL, in jsdom, exactly the way the shipped
 * <script src="/scripts.js"> tag does — the file is read from disk and
 * evaluated in the window, so a typo in the shipped helper fails here.
 * (Same philosophy as tests/ycSync.test.js. The only stub is `Swal`, which
 * scripts.js touches at top level to build window.Toast.)
 *
 * WHAT THIS PROTECTS
 *
 * applyFeSetting is the client-side mirror of the settings block in
 * routes/api.firmData.js:
 *
 *     const k = row.key.slice(3);              // drop 'fe-'
 *     let v = row.value;
 *     if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
 *     settings[k] = v;
 *
 * Two independent producers now write firmData.settings — that route at boot,
 * and this helper on every `setting:<key>` bus message. If they ever disagree
 * about a prefix, a parse or a fallback, the SAME setting renders differently
 * depending on whether you reloaded or received a broadcast, which is exactly
 * the class of bug nobody reproduces. These tests are the fence.
 *
 * The window.top case is not academic: pipelineBoard, tasks and the widgets
 * never alias firmData onto their own window, so for them the fallback IS the
 * path. It is exercised in a real jsdom iframe rather than simulated, because
 * on a top-level window `window.top === window` and the fallback would pass
 * for the wrong reason.
 *
 *   npx jest tests/applyFeSetting.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'public/scripts.js'), 'utf8');

const DOMS = [];
afterEach(() => DOMS.splice(0).forEach(d => {
  try { d.window.close(); } catch (_) { /* noop */ }
}));

/** scripts.js builds window.Toast from Swal at top level. Nothing else. */
function stubShellGlobals(w) {
  w.Swal = { mixin: () => ({ fire() {} }), fire() {} };
}

/**
 * A page that owns its own firmData — the shell, or a frame that aliased it
 * (case.html does `window.firmData = P.firmData`).
 */
function mkWindow({ settings } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://app.4lsg.com/',
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;
  stubShellGlobals(window);
  window.eval(SRC);
  if (settings !== undefined) window.firmData = { settings };
  return window;
}

/**
 * A REAL nested browsing context with no firmData of its own — pipelineBoard,
 * tasks, the widgets. Returns { top, child }.
 */
function mkFrame({ topSettings } = {}) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><iframe id="f"></iframe></body></html>',
    { url: 'https://app.4lsg.com/', runScripts: 'dangerously' }
  );
  DOMS.push(dom);
  const top = dom.window;
  const child = top.document.getElementById('f').contentWindow;
  stubShellGlobals(child);
  child.eval(SRC);
  if (topSettings !== undefined) top.firmData = { settings: topSettings };
  return { top, child };
}

// ─────────────────────────────────────────────────────────────
// The fe- prefix rule
// ─────────────────────────────────────────────────────────────

describe('applyFeSetting — the fe- prefix rule', () => {
  test('strips the prefix and writes under the bare name', () => {
    const w = mkWindow({ settings: {} });
    expect(w.applyFeSetting('fe-case_types', '{"Bankruptcy":["Chapter 7"]}')).toBe(true);
    expect(w.firmData.settings).toEqual({ case_types: { Bankruptcy: ['Chapter 7'] } });
    expect(w.firmData.settings['fe-case_types']).toBeUndefined();
  });

  test('a NON-fe key returns false and writes nothing', () => {
    // dropbox_case_folder_templates is a real editable row, and it is a SERVER
    // setting. It rides the bus like any other, and every frontend subscriber
    // must ignore it rather than inventing a firmData.settings entry for it.
    const w = mkWindow({ settings: { case_types: { A: [] } } });
    expect(w.applyFeSetting('dropbox_case_folder_templates', '{"x":1}')).toBe(false);
    expect(w.firmData.settings).toEqual({ case_types: { A: [] } });
  });

  test('a key that merely CONTAINS "fe-" is not a frontend setting', () => {
    const w = mkWindow({ settings: {} });
    expect(w.applyFeSetting('safe-mode', '1')).toBe(false);
    expect(w.firmData.settings).toEqual({});
  });

  test('a non-string key is rejected rather than coerced', () => {
    const w = mkWindow({ settings: {} });
    expect(w.applyFeSetting(null, 'x')).toBe(false);
    expect(w.applyFeSetting(undefined, 'x')).toBe(false);
    expect(w.firmData.settings).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────
// Parsing — must match routes/api.firmData.js exactly
// ─────────────────────────────────────────────────────────────

describe('applyFeSetting — parsing', () => {
  test('a JSON object value parses', () => {
    const w = mkWindow({ settings: {} });
    w.applyFeSetting('fe-case_types', '{"Appeal":["Bankruptcy","Litigation"]}');
    expect(w.firmData.settings.case_types).toEqual({ Appeal: ['Bankruptcy', 'Litigation'] });
  });

  test('a JSON array value parses', () => {
    const w = mkWindow({ settings: {} });
    w.applyFeSetting('fe-event_types', '["Hearing","Deadline"]');
    expect(w.firmData.settings.event_types).toEqual(['Hearing', 'Deadline']);
  });

  test('MALFORMED JSON falls back to the raw string — it does not throw or blank', () => {
    // The whole point of the raw-string fallback: plain scalars are stored
    // unquoted (fe-firm_phone is '2485551212', not '"2485551212"'), so a parse
    // failure is the NORMAL path for half the rows, not an error condition.
    const w = mkWindow({ settings: {} });
    expect(w.applyFeSetting('fe-case_types', '{"Bankruptcy":[')).toBe(true);
    expect(w.firmData.settings.case_types).toBe('{"Bankruptcy":[');
  });

  test('an unquoted scalar string survives as a string', () => {
    const w = mkWindow({ settings: {} });
    w.applyFeSetting('fe-firm_site_url', 'https://4lsg.com');
    expect(w.firmData.settings.firm_site_url).toBe('https://4lsg.com');
  });

  test('a bare number string parses to a NUMBER, same as the route', () => {
    // Not a quirk of this helper — JSON.parse('7') === 7 on the server too.
    // Pinned so the two can never diverge silently.
    const w = mkWindow({ settings: {} });
    w.applyFeSetting('fe-some_count', '7');
    expect(w.firmData.settings.some_count).toBe(7);
  });

  test('an empty-string value stays an empty string', () => {
    const w = mkWindow({ settings: { lead_sources: ['Google'] } });
    expect(w.applyFeSetting('fe-lead_sources', '')).toBe(true);
    expect(w.firmData.settings.lead_sources).toBe('');
  });

  test('a non-string value is passed through unparsed', () => {
    const w = mkWindow({ settings: {} });
    w.applyFeSetting('fe-thing', { already: 'parsed' });
    expect(w.firmData.settings.thing).toEqual({ already: 'parsed' });
  });

  test('parity with routes/api.firmData.js across the live fe-* row shapes', () => {
    // The route's loop, transcribed. Same inputs through both must agree.
    const route = (key, value) => {
      const k = key.slice(3);
      let v = value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* raw */ } }
      return { [k]: v };
    };
    const rows = [
      ['fe-case_types',    '{"Bankruptcy":["Chapter 7","Chapter 13"],"Other":[]}'],
      ['fe-event_types',   '["Hearing","Court Date"]'],
      ['fe-lead_sources',  '["Referral","Google"]'],
      ['fe-firm_phone',    '2485551212'],
      ['fe-firm_site_url', 'https://4lsg.com'],
      ['fe-trustees',      '{"broken":['],
      ['fe-blank',         ''],
    ];
    const w = mkWindow({ settings: {} });
    for (const [key, value] of rows) {
      w.applyFeSetting(key, value);
      expect({ [key.slice(3)]: w.firmData.settings[key.slice(3)] })
        .toEqual(route(key, value));
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Which object gets written
// ─────────────────────────────────────────────────────────────

describe('applyFeSetting — target resolution', () => {
  test('writes to window.firmData when the frame owns one', () => {
    const w = mkWindow({ settings: {} });
    const own = w.firmData;
    w.applyFeSetting('fe-event_types', '["Hearing"]');
    expect(w.firmData).toBe(own);              // mutated in place, never replaced
    expect(own.settings.event_types).toEqual(['Hearing']);
  });

  test('MUTATES IN PLACE — an aliased map (case.html) sees it too', () => {
    // case.html does `window.firmData = P.firmData`, so the shell's object and
    // the frame's are the SAME object. Replacing rather than mutating would
    // break that alias and strand the shell on the old value.
    const w = mkWindow();
    const shared = { settings: {} };
    w.firmData = shared;
    w.applyFeSetting('fe-lead_sources', '["Referral"]');
    expect(shared.settings.lead_sources).toEqual(['Referral']);
  });

  test('FALLS BACK to window.top.firmData in a frame that owns none', () => {
    const { top, child } = mkFrame({ topSettings: {} });
    expect(child.firmData).toBeUndefined();
    expect(child.applyFeSetting('fe-case_types', '{"Litigation":[]}')).toBe(true);
    expect(top.firmData.settings.case_types).toEqual({ Litigation: [] });
  });

  test('the frame prefers its OWN firmData over the shell when it has one', () => {
    const { top, child } = mkFrame({ topSettings: {} });
    child.firmData = { settings: {} };
    child.applyFeSetting('fe-case_types', '{"Appeal":[]}');
    expect(child.firmData.settings.case_types).toEqual({ Appeal: [] });
    expect(top.firmData.settings).toEqual({});
  });

  test('no firmData anywhere → false, and no throw', () => {
    const w = mkWindow();
    expect(w.firmData).toBeUndefined();
    expect(() => w.applyFeSetting('fe-case_types', '{}')).not.toThrow();
    expect(w.applyFeSetting('fe-case_types', '{}')).toBe(false);
  });

  test('a firmData with no settings map → false, and no settings map invented', () => {
    const w = mkWindow();
    w.firmData = { users: [] };
    expect(w.applyFeSetting('fe-case_types', '{}')).toBe(false);
    expect(w.firmData.settings).toBeUndefined();
  });

  test('IDEMPOTENT — the same message applied twice is the same state', () => {
    // Load-bearing: every frame applies the same payload because BroadcastChannel
    // delivery order across browsing contexts is unspecified.
    const w = mkWindow({ settings: {} });
    w.applyFeSetting('fe-case_types', '{"Bankruptcy":["Chapter 7"]}');
    const after = JSON.stringify(w.firmData.settings);
    w.applyFeSetting('fe-case_types', '{"Bankruptcy":["Chapter 7"]}');
    expect(JSON.stringify(w.firmData.settings)).toBe(after);
  });

  test('other settings keys are untouched', () => {
    const w = mkWindow({ settings: { event_types: ['Hearing'], firm_phone: '1' } });
    w.applyFeSetting('fe-case_types', '{}');
    expect(w.firmData.settings.event_types).toEqual(['Hearing']);
    expect(w.firmData.settings.firm_phone).toBe('1');
  });
});

// ─────────────────────────────────────────────────────────────
// The consumers actually read the new value
// ─────────────────────────────────────────────────────────────

describe('applyFeSetting — downstream readers pick it up with no refetch', () => {
  test('getCaseTypeMap() reflects a bus-applied fe-case_types', () => {
    const w = mkWindow({ settings: {} });
    expect(w.getCaseTypeMap()).toHaveProperty('Bankruptcy');   // built-in default
    w.applyFeSetting('fe-case_types', '{"Litigation":["Contract"]}');
    expect(w.getCaseTypeMap()).toEqual({ Litigation: ['Contract'] });
  });

  test('getEventTypeOptions() reflects a bus-applied fe-event_types', () => {
    const w = mkWindow({ settings: {} });
    w.applyFeSetting('fe-event_types', '["Only This"]');
    expect(w.getEventTypeOptions()).toEqual(['Only This']);
  });

  test('a malformed fe-case_types degrades to the built-in default, not a crash', () => {
    const w = mkWindow({ settings: {} });
    w.applyFeSetting('fe-case_types', 'not json at all');
    expect(w.getCaseTypeMap()).toHaveProperty('Bankruptcy');
  });
});
