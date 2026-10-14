// tests/commsSummaryPrompt.test.js
//
// Comms archive S3 — the summary prompt (lib/aiPrompts/commsSummary.js) states
// the rules the grounding check enforces, so the model is not asked to guess
// them (round 2, 2026-10-15). Real registry; no stand-ins.

'use strict';

const { getPrompt } = require('../lib/aiPrompts');

describe('comms_summary prompt', () => {
  const p = getPrompt('comms_summary');

  test('registered: Sonnet 5.5 default, json, 16000 tokens, version 2', () => {
    expect(p).toMatchObject({ model: 'claude-sonnet-5-5', output_type: 'json', max_tokens: 16000, version: '2' });
  });

  test('states the grounding rules the validator enforces', () => {
    expect(p.system).toMatch(/A quote is at least 3 words/);
    expect(p.system).toMatch(/a date, amount or case reference may quote just the\s+words that state it/);
    expect(p.system).toMatch(/a commitment may quote a whole short line/);
    expect(p.system).toMatch(/"date_text", "amount_text" and a case ref's "text" are copied from INSIDE that item's own quote/);
    expect(p.system).toMatch(/A commitment's quote comes from ONE speaker's words only/);
  });

  test('every {{var}} the sweep fills is in the template, and nothing else', () => {
    const vars = [...new Set((p.system.match(/{{(\w+)}}/g) || []).map(v => v.slice(2, -2)))].sort();
    expect(vars).toEqual(['call_date', 'cases', 'contact', 'direction', 'item_kind']);
  });
});
