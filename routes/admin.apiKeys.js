// routes/admin.apiKeys.js
//
/**
 * API Keys admin — superuser-only management of inbound credentials.
 * Auto-mounts (routes/). UI: public/apiKeys.html.
 *
 *   GET  /api/api-keys                  — external keys list + internal-key status
 *   POST /api/api-keys      {label}     — mint external key; raw returned ONCE
 *   POST /api/api-keys/:id/revoke       — revoke external key (immediate on this
 *                                         instance; ≤60s on others via cache TTL)
 *   POST /api/api-keys/rotate-internal  — rotate the app-to-self key
 *
 * ROTATION SEMANTICS (see lib/firmConfig.js + lib/auth.jwtOrApiKey.js):
 *   current effective key (internal_api_key setting → INTERNAL_API_KEY env)
 *   moves to internal_api_key_prev; a fresh yci_ key becomes current. Both
 *   slots verify, so the 60s config-cache skew across instances is harmless.
 *   The displaced key stays valid until the NEXT rotation — which also means:
 *   any EXTERNAL system still calling with the internal key (e.g. Pabbly
 *   pre-migration) survives exactly one rotation. Mint it a named key first.
 *
 * Key material is never returned by rotate, never audit-logged, and never
 * stored in plaintext for external keys (hash only).
 */

const express = require('express');
const router = express.Router();
const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');
const apiKeys = require('../lib/apiKeys');
const firmConfig = require('../lib/firmConfig');

const TOOL = 'api_keys';
const MAX_LABEL_LEN = 100;

function reqMeta(req) {
  return {
    tool: TOOL,
    userId: req.auth?.userId ?? null,
    username: req.auth?.username ?? null,
    route: req.originalUrl,
    method: req.method,
    ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

/**
 * Rotate the internal key. Exported for tests.
 * Reads the current slot from the DB directly (not cfg — the cache may be up
 * to 60s stale and rotation must chain exactly), falling back to the env var
 * for the first-ever rotation. Single atomic UPDATE writes both slots.
 * @returns {{ hadPrevious: boolean }}
 */
async function rotateInternal(db) {
  const [[row]] = await db.query(
    "SELECT `value` FROM app_settings WHERE `key` = 'internal_api_key'"
  );
  const displaced = (row && row.value) || process.env.INTERNAL_API_KEY || null;
  const next = apiKeys.generateKey('yci_');

  const [res] = await db.query(
    "UPDATE app_settings SET `value` = CASE `key` " +
    "WHEN 'internal_api_key' THEN ? WHEN 'internal_api_key_prev' THEN ? END " +
    "WHERE `key` IN ('internal_api_key','internal_api_key_prev')",
    [next, displaced]
  );
  // CASE-UPDATE matched rows = rows present. Both must exist (K1 migration).
  if ((res.affectedRows ?? 0) < 2) {
    throw new Error(
      'internal_api_key settings rows missing — run the K1 api_keys migration SQL first'
    );
  }
  firmConfig.invalidate();
  return { hadPrevious: displaced != null };
}

// ── GET list + internal status ───────────────────────────────────────────────
router.get('/api/api-keys', ...superuserOnlyFor(TOOL), async (req, res) => {
  try {
    const keys = await apiKeys.listKeys(req.db);
    const [rows] = await req.db.query(
      "SELECT `key`, `value` IS NOT NULL AS is_set, updated_at " +
      "FROM app_settings WHERE `key` IN ('internal_api_key','internal_api_key_prev')"
    );
    const bySlot = Object.fromEntries(rows.map((r) => [r.key, r]));
    const cur = bySlot['internal_api_key'];
    res.json({
      status: 'success',
      keys,
      internal: {
        // false = still running on the INTERNAL_API_KEY env var (never rotated)
        rotated: !!(cur && Number(cur.is_set)),
        last_rotated_at: cur && Number(cur.is_set) ? cur.updated_at : null,
        has_previous: !!(bySlot['internal_api_key_prev'] && Number(bySlot['internal_api_key_prev'].is_set)),
      },
    });
  } catch (err) {
    console.error('GET /api/api-keys error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to load keys' });
  }
});

// ── POST create external key ─────────────────────────────────────────────────
router.post('/api/api-keys', ...superuserOnlyFor(TOOL), async (req, res) => {
  const label = String(req.body?.label ?? '').trim();
  if (!label) {
    return res.status(400).json({ status: 'error', message: 'label is required' });
  }
  if (label.length > MAX_LABEL_LEN) {
    return res.status(400).json({ status: 'error', message: `label exceeds ${MAX_LABEL_LEN} chars` });
  }
  try {
    const out = await apiKeys.createKey(req.db, label, req.auth.userId);
    await auditAdminAction(req.db, {
      ...reqMeta(req),
      status: 'created',
      details: { key_id: out.id, label: out.label, key_prefix: out.key_prefix },
    });
    // The ONLY time the raw key ever leaves the server.
    res.json({ status: 'success', key: out.raw, id: out.id, label: out.label, key_prefix: out.key_prefix });
  } catch (err) {
    console.error('POST /api/api-keys error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to create key' });
  }
});

// ── POST revoke ──────────────────────────────────────────────────────────────
router.post('/api/api-keys/:id/revoke', ...superuserOnlyFor(TOOL), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ status: 'error', message: 'invalid id' });
  }
  try {
    await apiKeys.revokeKey(req.db, id);
    await auditAdminAction(req.db, {
      ...reqMeta(req),
      status: 'revoked',
      details: { key_id: id },
    });
    res.json({ status: 'success' });
  } catch (err) {
    console.error(`POST /api/api-keys/${id}/revoke error:`, err);
    res.status(500).json({ status: 'error', message: 'Failed to revoke key' });
  }
});

// ── POST rotate internal ─────────────────────────────────────────────────────
router.post('/api/api-keys/rotate-internal', ...superuserOnlyFor(TOOL), async (req, res) => {
  try {
    const { hadPrevious } = await rotateInternal(req.db);
    await auditAdminAction(req.db, {
      ...reqMeta(req),
      status: 'rotated_internal',
      details: { had_previous: hadPrevious }, // never key material
    });
    res.json({ status: 'success', rotated_at: new Date().toISOString() });
  } catch (err) {
    console.error('POST /api/api-keys/rotate-internal error:', err);
    res.status(500).json({ status: 'error', message: err.message || 'Rotation failed' });
  }
});

module.exports = router;
module.exports._rotateInternal = rotateInternal; // exported for tests