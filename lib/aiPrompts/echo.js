// lib/aiPrompts/echo.js
//
// Trivial smoke prompt. Used by routes/_aitest.js to confirm the full
// aiService → credentialInjection(12) → Anthropic path works end-to-end and
// writes an ai_calls row. Not a real consumer prompt.

module.exports = {
  key: 'echo',
  system: 'Reply with exactly the text the user sends, nothing else.',
  model: 'claude-sonnet-4-6',
  max_tokens: 64,
  output_type: 'text',
  version: '1',
};