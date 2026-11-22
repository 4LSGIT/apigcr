// search_docs — the shipped manual, as v1 reads it (services/assistantKnowledgeService).
'use strict';

const knowledge = require('../../assistantKnowledgeService');

module.exports = {
  name: 'search_docs',
  description: 'Full-text search over the YisraCase product manual (manual/). Returns up to 8 chapters with title, manual path and an excerpt. Use it for how a feature behaves for staff; use read_source for how the code behaves.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 300, description: 'Words to look for (2–10 terms are used).' },
      limit: { type: 'integer', minimum: 1, maximum: 8, description: 'Max chapters (default 5).' },
    },
    required: ['query'],
  },
  untrusted: true,
  async run(_ctx, input) {
    const hits = knowledge.search(input.query, input.limit || 5);
    return { query: input.query, count: hits.length, hits };
  },
};
