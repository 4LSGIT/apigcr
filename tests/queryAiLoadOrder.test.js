// tests/queryAiLoadOrder.test.js
//
/**
 * query_ai survives the production module load order (lib/internal_functions/ai.js header).
 * Run: npx jest tests/queryAiLoadOrder.test.js
 *
 * THE DEFECT (live 2026-10-23 → 10-26): services/aiService → lib/aiPrompts →
 * assistantAnswer (generates its function reference from the registry at
 * load) → lib/internal_functions → ai.js → services/aiService, still loading.
 * ai.js held aiService at module scope, so it captured the half-built exports
 * object that aiService's final `module.exports = {…}` then replaced; on a
 * process that loads aiService first, query_ai threw "aiService.call is not a
 * function". wf27 (website leads) step 44 failed on every lead (executions
 * 15288, 15292, 15376, 15410 — completed_with_errors, no AI triage).
 *
 * REAL modules, real load order — aiService is required FIRST, exactly as a
 * route does in production. Only aiService.call is replaced (no network).
 *
 * Mutation-checked: ai.js back to a module-scope
 * `const aiService = require('../../services/aiService')` → "query_ai reaches
 * aiService.call …" fails with "aiService.call is not a function".
 */

'use strict';

const aiService = require('../services/aiService');      // FIRST — the order that broke production
const fns = require('../lib/internal_functions');

afterEach(() => jest.restoreAllMocks());

test('the cycle is real: loading aiService first pulls the function registry in mid-load', () => {
  // If this stops being true the lazy require is merely harmless, not load-bearing.
  const cached = Object.keys(require.cache);
  expect(cached.some(k => k.endsWith('lib/aiPrompts/assistantAnswer.js'))).toBe(true);
  expect(cached.some(k => k.endsWith('lib/internal_functions/ai.js'))).toBe(true);
});

test('query_ai reaches aiService.call when aiService was loaded before the registry', async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const call = jest.spyOn(aiService, 'call').mockResolvedValue({
    ok: true, output: 'triaged', json: null, usage: { input_tokens: 3, output_tokens: 1 }, callId: 77,
  });
  const db = { query: jest.fn(async () => [[]]) };
  const r = await fns.query_ai({ prompt: 'Classify this lead.', input: 'hello', output_var: 'ai_out' }, db);

  expect(call).toHaveBeenCalledTimes(1);
  expect(call.mock.calls[0][0]).toBe(db);
  expect(call.mock.calls[0][1]).toMatchObject({ inlineSystem: 'Classify this lead.', userInput: 'hello', consumerRef: 'query_ai' });
  expect(r).toEqual({ success: true, output: 'triaged', set_vars: { ai_out: 'triaged' }, usage: { input_tokens: 3, output_tokens: 1 }, call_id: 77 });
});
