// lib/internal_functions/ai.js
const aiService      = require('../../services/aiService');

const fns = {};

// ─────────────────────────────────────────────────────────────
// AI
// ─────────────────────────────────────────────────────────────

/**
 * query_ai
 * Send a prompt (plus optional untrusted input text) to Claude via
 * aiService and return the response. Thin wrapper: credential (id 12),
 * ai_calls logging (tokens/cost/latency), <untrusted_user_input> wrapping,
 * and JSON parse + one strict retry all live in services/aiService.js.
 *
 * SECURITY: put INSTRUCTIONS in `prompt` and any FOREIGN TEXT (email
 * bodies, inbound messages, scraped text) in `input`. `input` is wrapped
 * in <untrusted_user_input> tags with a never-obey guard; `prompt` is not.
 * The engine resolves {{placeholders}} in both before this function runs,
 * so nothing technically stops {{trigger.email_body}} inside `prompt` —
 * don't do that.
 *
 * params:
 *   prompt       {string}   — required. Instructions (system prompt).
 *   input        {string?}  — the data to analyze. Non-strings (e.g. a
 *                             query_db output object via the engine's
 *                             single-placeholder fast path) are
 *                             JSON.stringified.
 *   model        {string?}  — default 'claude-sonnet-4-6'.
 *   output_type  {string?}  — 'text' (default) | 'json'. json → output is
 *                             the parsed object.
 *   max_tokens   {number?}  — default 1024.
 *   timeout_ms   {number?}  — per-attempt API timeout; aiService clamps
 *                             to 1s–60s. Default 20s.
 *   output_var   {string?}  — also copy output into this named variable
 *                             (query_db convention) for later steps.
 *
 * Output (same-step set_vars): {{this.output}} is the response text, or
 * for output_type=json, {{this.output.fieldname}} on the parsed object.
 * Later steps must use output_var (next step's `this` is reset).
 *
 * Failure (api_error / timeout / json_parse after retry / no_auth) throws,
 * so the step's error_policy applies. NOTE: error_policy retries re-bill
 * the API — every attempt is an ai_calls row (consumer_ref='query_ai').
 *
 * example config:
 *   {
 *     "function_name": "query_ai",
 *     "params": {
 *       "prompt": "Extract the caller's callback number from the email. Respond with JSON: {\"phone\": string|null}",
 *       "input": "{{trigger.email_body}}",
 *       "output_type": "json",
 *       "output_var": "parsed"
 *     },
 *     "set_vars": { "callbackPhone": "{{this.output.phone}}" }
 *   }
 */

fns.query_ai = async (params, db) => {
    const {
      prompt,
      input = null,
      model = 'claude-sonnet-4-6',
      output_type = 'text',
      max_tokens = 1024,
      timeout_ms,
      output_var = null,
    } = params;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('query_ai: "prompt" is required');
    }

    let userInput = null;
    if (input != null && input !== '') {
      userInput = typeof input === 'string' ? input : JSON.stringify(input);
    }

    console.log(`[QUERY_AI] model=${model} output_type=${output_type} input_len=${userInput ? userInput.length : 0}`);

    const result = await aiService.call(db, {
      inlineSystem: prompt,
      userInput,
      model,
      max_tokens: Number(max_tokens) || 1024,
      outputType: output_type,
      timeout_ms,
      consumerRef: 'query_ai',
    });

    if (!result.ok) {
      const detail = result.detail ? ` — ${result.detail}` : '';
      throw new Error(`query_ai failed: ${result.error}${detail} (ai_calls id ${result.callId ?? 'n/a'})`);
    }

    const output = output_type === 'json' ? result.json : result.output;

    const set_vars = {};
    if (output_var) set_vars[output_var] = output;

    return {
      success: true,
      output,
      set_vars,
      usage: result.usage || null,
      call_id: result.callId ?? null,
    };
  };

fns.query_ai.__meta = {
  category: 'ai',
  description: 'Send a prompt to Claude (AI) and use the response. Put instructions in "prompt" and any foreign text (email bodies, inbound messages) in "input" — input is wrapped in an injection guard, prompt is not. Same-step set_vars: {{this.output}} (text) or {{this.output.field}} (json). Use output_var to expose the result to later steps. Every attempt is logged to ai_calls with cost.',
  params: [
    { name: 'prompt', type: 'string', required: true, placeholderAllowed: true, multiline: true,
      description: 'Instructions for the AI. {{placeholders}} resolve before sending. Do NOT paste untrusted text here — use "input".',
      example: 'Extract the caller\'s callback phone number from the email. Respond with JSON: {"phone": string|null}' },
    { name: 'input', type: 'string', required: false, placeholderAllowed: true, multiline: true,
      description: 'The data to analyze (email body, message text, query_db output). Wrapped in <untrusted_user_input> with a never-obey guard.',
      example: '{{trigger.email_body}}' },
    { name: 'model', type: 'enum', required: false,
      enum: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'], default: 'claude-sonnet-4-6',
      description: 'Sonnet = smarter (default). Haiku = cheaper/faster for simple parses. New models: add to this enum AND aiService MODEL_PRICING.' },
    { name: 'output_type', type: 'enum', required: false, enum: ['text', 'json'], default: 'text',
      description: '"json": response is parsed (one strict retry on garbage) into an object — access fields via {{this.output.field}} in set_vars. "text": raw text.' },
    { name: 'max_tokens', type: 'integer', required: false, default: 1024, min: 1, max: 8192,
      description: 'Response length cap. Long compositions at high caps may also need a higher timeout_ms.' },
    { name: 'timeout_ms', type: 'integer', required: false, default: 20000, min: 1000, max: 60000,
      description: 'Per-attempt API timeout in ms. Default 20000 (20s).' },
    { name: 'output_var', type: 'string', required: false,
      description: 'Also copy the output into this named workflow variable for later steps (like query_db).',
      example: 'ai_result' },
  ],
  example: {
    prompt: 'Extract the caller\'s callback phone number from the email. Respond with JSON: {"phone": string|null}',
    input: '{{trigger.email_body}}',
    output_type: 'json',
    output_var: 'parsed'
  }
};

module.exports = fns;
