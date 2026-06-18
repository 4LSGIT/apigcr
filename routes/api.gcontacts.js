// routes/api.gcontacts.js
//
/**
 * Google Contacts Sync API Routes
 * routes/api.gcontacts.js
 *
 * Thin HTTP surface over services/gContactsService.js. No direct People API or
 * raw-SQL work lives here. All routes are under jwtOrApiKey; req.db is the
 * mysql2 pool.
 *
 * Routes:
 *   POST /api/gcontacts/push/:contactId  — upsert one contact (force? in body to ignore exclusions)
 *   POST /api/gcontacts/sync-pending     — drift sweep; body { limit? } (wire to scheduler nightly)
 *   POST /api/gcontacts/import-links     — one-time post-migration column backfill from Google externalIds
 *   POST /api/gcontacts/ensure-group     — create/find the "YisraCase" group, persist to app_settings
 *   GET  /api/gcontacts/connections      — diagnostics; returns counts + first N
 *
 * See gContactsService.js for the sync policy (YisraCase-authoritative names,
 * union phones/emails, never write SSN/notes). People API requires
 * https://people.googleapis.com/* in the credential's allowed_urls and the
 * https://www.googleapis.com/auth/contacts scope.
 */

const express      = require('express');
const jwtOrApiKey  = require('../lib/auth.jwtOrApiKey');
const gcontacts    = require('../services/gContactsService');

const router = express.Router();

// POST /api/gcontacts/push/:contactId
router.post('/api/gcontacts/push/:contactId', jwtOrApiKey, async (req, res) => {
  try {
    const contactId = parseInt(req.params.contactId, 10);
    if (!Number.isFinite(contactId)) return res.status(400).json({ error: 'invalid contactId' });
    const result = await gcontacts.pushContact(req.db, contactId, { force: !!(req.body && req.body.force) });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[POST /api/gcontacts/push]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gcontacts/sync-pending
router.post('/api/gcontacts/sync-pending', jwtOrApiKey, async (req, res) => {
  try {
    const limit = req.body && req.body.limit;
    const result = await gcontacts.syncPending(req.db, { limit });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[POST /api/gcontacts/sync-pending]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gcontacts/import-links
router.post('/api/gcontacts/import-links', jwtOrApiKey, async (req, res) => {
  try {
    const result = await gcontacts.importLinks(req.db);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[POST /api/gcontacts/import-links]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gcontacts/ensure-group
router.post('/api/gcontacts/ensure-group', jwtOrApiKey, async (req, res) => {
  try {
    const result = await gcontacts.ensureGroup(req.db, { name: req.body && req.body.name });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[POST /api/gcontacts/ensure-group]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gcontacts/connections  (diagnostics)
router.get('/api/gcontacts/connections', jwtOrApiKey, async (req, res) => {
  try {
    const { people, syncToken } = await gcontacts.listConnections(req.db, {});
    const n = Math.min(parseInt(req.query.n, 10) || 5, 50);
    res.json({
      success: true,
      total: people.length,
      syncToken: !!syncToken,
      tagged: people.filter(p => (p.externalIds || []).some(e => e.type === 'yisracase')).length,
      sample: people.slice(0, n).map(p => ({
        resourceName: p.resourceName,
        name: p.names && p.names[0] && p.names[0].displayName,
        externalIds: (p.externalIds || []).map(e => `${e.type}:${e.value}`),
      })),
    });
  } catch (err) {
    console.error('[GET /api/gcontacts/connections]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;