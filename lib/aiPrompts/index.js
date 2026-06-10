// lib/aiPrompts/index.js
//
// Prompt registry for aiService. Each prompt module exports a descriptor:
//   { key, system, model, max_tokens, output_type, version }
// getPrompt(key) returns the descriptor (with model/max_tokens/output_type/
// version surfaced) or null for an unknown key.
//
// To add a prompt: create lib/aiPrompts/<name>.js exporting the descriptor,
// then require + register it below.

const echo = require('./echo');
const courtExtract = require('./courtExtract');

const REGISTRY = {
  [echo.key]: echo,
  [courtExtract.key]: courtExtract,
};

/**
 * Look up a registered prompt descriptor by key.
 * @param {string} key
 * @returns {{system:string, model:string, max_tokens:number,
 *            output_type:string, version:string}|null}
 */
function getPrompt(key) {
  const p = REGISTRY[key];
  if (!p) return null;
  return {
    system: p.system,
    model: p.model,
    max_tokens: p.max_tokens,
    output_type: p.output_type,
    version: p.version,
  };
}

module.exports = { getPrompt, REGISTRY };