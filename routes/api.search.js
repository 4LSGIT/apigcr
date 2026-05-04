/**
 * Search API
 * routes/api.search.js
 *
 * GET /api/search?q=...&type=all&limit=1
 *
 * Unified search across contacts and cases.
 * Replaces the raw SQL quickPick queries.
 *
 */

const express       = require('express');
const router        = express.Router();
const jwtOrApiKey   = require('../lib/auth.jwtOrApiKey');
const searchService = require('../services/searchService');

router.get('/api/search', jwtOrApiKey, async (req, res) => {
  const { q, type = 'all', limit = 1 } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ status: 'error', message: 'q is required' });
  }

  const validTypes = ['all', 'contact', 'case'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ status: 'error', message: `type must be one of: ${validTypes.join(', ')}` });
  }

  try {
    const result = await searchService.search(req.db, {
      q,
      type,
      limit: parseInt(limit) || 1
    });
    res.json(result);
  } catch (err) {
    console.error('GET /api/search error:', err);
    res.status(500).json({ status: 'error', message: 'Search failed' });
  }
});

module.exports = router;