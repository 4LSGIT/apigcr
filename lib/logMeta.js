// lib/logMeta.js
function buildMeta({
  stage,
  code,
  attempts = 1,
  provider,
  providerMessageId,
  retryable = false
}) {
  return {
    stage,
    code,
    attempts,
    provider,
    provider_message_id: providerMessageId,
    retryable,
    timestamp: new Date().toISOString()
  };
}

module.exports = { buildMeta };
