// Casey v2 S2 — lib/caseyPrompt.js: the system prompt is code, versioned,
// byte-identical per process, generic (no firm or person names), carries the
// reporting schema and the data rules; signature() covers system + tools.
// Also pins the model / effort menus: lib/settingsRegistry.js options ===
// services/casey/loop.js MODELS / EFFORTS (the loop reads the setting through
// its own list, so the two cannot drift silently).
'use strict';

const prompt = require('../lib/caseyPrompt');
const tools = require('../services/casey/tools');
const manifest = require('../lib/reportSchema/manifest');
const reg = require('../lib/settingsRegistry');
const loop = require('../services/casey/loop');
const aiService = require('../services/aiService');

test('version pinned; the text is built once and byte-identical; the schema context and the rules are in it', () => {
  expect(prompt.VERSION).toBe('v2.1');
  const a = prompt.systemText();
  const b = prompt.systemText();
  expect(a).toBe(b);
  expect(a.endsWith(manifest.toPromptContext() + '\n')).toBe(true);
  expect(a.length).toBeGreaterThan(manifest.toPromptContext().length + 3000);
  for (const must of ['whoami', 'lookup_routes', 'api_get', 'sql_read', 'read_source', 'search_docs',
    'untrusted: true', 'Social Security', 'date of birth', 'password', 'LIMIT of 1–250', 'log_date', 'processed_at', 'CONVERT_TZ',
    'READ-ONLY', 'contact_kind', 'case_relate_type', 'ONLY_FULL_GROUP_BY', 'truncated: true',
    'tie for that place', 'Page line']) {
    expect(a).toContain(must);
  }
  // Nothing volatile in Casey's own text: no clock, no user, no zone value baked
  // in (the manifest's schema notes, appended after it, are the manifest's own).
  expect(prompt._TEXT).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  expect(prompt._TEXT).not.toMatch(/America\/Detroit/);
  expect(prompt._TEXT).not.toMatch(/user_id \d/);
});

test('generic: Casey\'s own text names no firm or person (the manifest\'s example values are the manifest\'s)', () => {
  const a = prompt._TEXT.toLowerCase();
  for (const name of ['4lsg', 'fred', 'stuart', 'rena', 'metrodetroit', 'southfield']) expect(a).not.toContain(name);
});

test('signature(tools): stable across calls, changes with the tool definitions or the text', () => {
  const defs = tools.definitions();
  const s1 = prompt.signature(defs);
  expect(s1).toMatch(/^v2\.1-[0-9a-f]{8}$/);
  expect(prompt.signature(tools.definitions())).toBe(s1);
  const altered = defs.map((d, i) => (i === 0 ? { ...d, description: d.description + ' ' } : d));
  expect(prompt.signature(altered)).not.toBe(s1);
  expect(prompt.signature([])).not.toBe(s1);
});

test('the model and effort menus: registry options === the loop\'s lists; every model is priced', () => {
  expect(reg.SETTINGS.casey_v2_model.options).toEqual([...loop.MODELS]);
  expect(reg.SETTINGS.casey_v2_effort.options).toEqual([...loop.EFFORTS]);
  expect(loop.MODELS).toContain(loop.DEFAULT_MODEL);
  expect(loop.EFFORTS).toContain(loop.DEFAULT_EFFORT);
  for (const m of loop.MODELS) expect(aiService.MODEL_PRICING[m]).toBeDefined();   // a casey_v2 row never logs cost NULL
});
