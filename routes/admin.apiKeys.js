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
 *   GET  /api/api-keys/internal/log     — usage log for the internal key
 *   GET  /api/api-keys/rejected         — app-wide 401s (no credential resolved)
 *   GET  /api/api-keys/:id/log          — usage log for one external key
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
 *
 * USAGE LOG — READ THIS BEFORE TRUSTING THE NUMBERS
 *   There is no api_key_id column on jwt_api_audit_log. lib/auth.jwtOrApiKey
 *   writes the key's LABEL into `username` (and the literal 'internal' for the
 *   self-credential; pre-K1 rows used 'API_KEY' for the same thing). So the
 *   only available join is label → username, with these consequences:
 *     - Rows are lower-bounded at the key's created_at, and upper-bounded at
 *       the created_at of the NEXT key sharing the same label. That makes
 *       label REUSE (revoke "Pabbly", mint a new "Pabbly") unambiguous.
 *     - Two keys alive at once under the SAME label are NOT separable. The
 *       response sets label_shared:true so the UI can say so out loud.
 *     - Rejected calls are invisible here. An unrecognized/revoked key never
 *       resolves to a label, so jwtOrApiKey logs username=NULL. "No rows since
 *       revocation" therefore means nothing — it is not evidence the caller
 *       stopped.
 *   jwt_api_audit_log has no index beyond the PK (~103k rows, write-heavy on
 *   every authenticated request). These queries are backward PK scans with a
 *   filter — ~200ms worst case today, which is fine for an admin-only screen.
 *   Paging is keyset (beforeId) precisely so it does not degrade with depth.
 *   If the table passes ~1M rows, revisit — but weigh an index against the
 *   write cost on the hottest insert path in the app before adding one.
 */

const express = require('express');
const router = express.Router();
const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');
const apiKeys = require('../lib/apiKeys');
const firmConfig = require('../lib/firmConfig');

const TOOL = 'api_keys';
const MAX_LABEL_LEN = 100;

// Usage-log tuning.
const LOG_LIMIT_DEFAULT = 100;
const LOG_LIMIT_MAX     = 500;
const PAYLOAD_CHARS     = 2000;  // per-column cap on query_params/body text
// Labels jwtOrApiKey has used for the internal self-credential. 'API_KEY' is
// the pre-K1 marker — same key, older code path. Both belong to one timeline.
const INTERNAL_LABELS   = ['internal', 'API_KEY'];

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

/** Shared limit/cursor parsing for both log endpoints. */
function logPaging(query) {
  const limit = Math.min(
    LOG_LIMIT_MAX,
    Math.max(1, parseInt(query.limit, 10) || LOG_LIMIT_DEFAULT)
  );
  // Keyset cursor: strictly-less-than on the PK. Cheaper than OFFSET and
  // stable under concurrent inserts (this table is written on every request).
  const raw = parseInt(query.beforeId, 10);
  const beforeId = Number.isInteger(raw) && raw > 0 ? raw : null;
  return { limit, beforeId };
}

// One projection for both log views so the UI can render either with the same
// row shape. query_params/body are JSON columns; CAST → LEFT caps them.
const LOG_COLUMNS =
  `id, created_at, route, method, ip_address, user_agent, auth_status, username,
   LEFT(CAST(query_params AS CHAR), ${PAYLOAD_CHARS}) AS query_text,
   LEFT(CAST(body         AS CHAR), ${PAYLOAD_CHARS}) AS body_text`;

/**
 * Fetch audit rows for a set of labels within an optional time window.
 * @param {string[]} labels    usernames to match (label === username)
 * @param {Date|null} since    inclusive lower bound (key creation)
 * @param {Date|null} until    exclusive upper bound (next same-label key)
 */
async function fetchKeyLog(db, labels, { since, until, limit, beforeId }) {
  const where = ["auth_type = 'api_key'", `username IN (${labels.map(() => '?').join(',')})`];
  const params = [...labels];
  if (since)    { where.push('created_at >= ?'); params.push(since); }
  if (until)    { where.push('created_at < ?');  params.push(until); }
  if (beforeId) { where.push('id < ?');          params.push(beforeId); }

  const [rows] = await db.query(
    `SELECT ${LOG_COLUMNS}
       FROM jwt_api_audit_log
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT ?`,
    [...params, limit]
  );
  return rows;
}

/**
 * Fetch requests rejected for presenting no usable credential.
 *
 * SCOPE — auth_type='none' AND auth_status='unauthorized', deliberately narrow:
 *   - 'none' is where a bad/revoked x-api-key lands. jwtOrApiKey falls through
 *     to the JWT check on an unrecognized key, finds no Bearer header, and logs
 *     (none, null, unauthorized). requireAuth writes ('jwt', <username>,
 *     'unauthorized') for role/audience failures — a staff-permissions problem,
 *     not a credential one, so it's excluded.
 *   - 'invalid_token' is excluded too: ~1.3k rows, overwhelmingly expired
 *     browser JWTs, which would bury the ~290 rows that matter.
 *
 * There is no key attribution here and there cannot be — logJwtApiAttempt
 * deletes x-api-key from the stored headers before the row is written, so the
 * presented key never reaches the table in any form. user_agent and ip are the
 * only handles, which in practice is enough: a caller keeps its UA across a
 * credential change. See the note in public/apikeys.html.
 */
async function fetchRejected(db, { limit, beforeId }) {
  const where = ["auth_type = 'none'", "auth_status = 'unauthorized'"];
  const params = [];
  if (beforeId) { where.push('id < ?'); params.push(beforeId); }

  const [rows] = await db.query(
    `SELECT ${LOG_COLUMNS}
       FROM jwt_api_audit_log
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT ?`,
    [...params, limit]
  );
  return rows;
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

// ── GET internal-key usage log ───────────────────────────────────────────────
// MUST be declared before /api/api-keys/:id/log — Express matches in order and
// ':id' would otherwise swallow 'internal'.
router.get('/api/api-keys/internal/log', ...superuserOnlyFor(TOOL), async (req, res) => {
  const { limit, beforeId } = logPaging(req.query);
  try {
    // An external key labelled 'internal' would be indistinguishable here.
    // Nothing forbids that label today, so check rather than assume.
    const [[dupe]] = await req.db.query(
      'SELECT COUNT(*) AS n FROM api_keys WHERE label IN (?, ?) AND revoked_at IS NULL',
      INTERNAL_LABELS
    );
    const log = await fetchKeyLog(req.db, INTERNAL_LABELS, {
      since: null, until: null, limit, beforeId,
    });
    res.json({
      status: 'success',
      key: { id: 'internal', label: 'internal' },
      window: { since: null, until: null },
      label_shared: Number(dupe?.n || 0) > 0,
      log,
      limit,
      next_before_id: log.length === limit ? log[log.length - 1].id : null,
    });
  } catch (err) {
    console.error('GET /api/api-keys/internal/log error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to load log' });
  }
});

// ── GET rejected calls ───────────────────────────────────────────────────────
// App-wide, not per-key: rejected rows carry no key identity to filter on.
// Same row shape as the per-key logs so the UI reuses one renderer.
router.get('/api/api-keys/rejected', ...superuserOnlyFor(TOOL), async (req, res) => {
  const { limit, beforeId } = logPaging(req.query);
  try {
    const log = await fetchRejected(req.db, { limit, beforeId });
    res.json({
      status: 'success',
      log,
      limit,
      next_before_id: log.length === limit ? log[log.length - 1].id : null,
    });
  } catch (err) {
    console.error('GET /api/api-keys/rejected error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to load rejected calls' });
  }
});

// ── GET external-key usage log ───────────────────────────────────────────────
router.get('/api/api-keys/:id/log', ...superuserOnlyFor(TOOL), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ status: 'error', message: 'invalid id' });
  }
  const { limit, beforeId } = logPaging(req.query);

  try {
    const [[key]] = await req.db.query(
      'SELECT id, label, created_at, revoked_at FROM api_keys WHERE id = ?',
      [id]
    );
    if (!key) {
      return res.status(404).json({ status: 'error', message: 'key not found' });
    }

    // Upper bound = the moment a LATER key took over this label. Without it,
    // a reused label shows the predecessor's traffic as if it were this key's.
    // Pure aggregate, no GROUP BY — safe under the relaxed sql_mode.
    const [[nextSame]] = await req.db.query(
      'SELECT MIN(created_at) AS next_at FROM api_keys WHERE label = ? AND id > ?',
      [key.label, id]
    );
    const until = nextSame?.next_at || null;

    // Simultaneously-live duplicates can't be separated at all — flag them.
    const [[dupe]] = await req.db.query(
      'SELECT COUNT(*) AS n FROM api_keys WHERE label = ? AND id <> ?',
      [key.label, id]
    );

    const log = await fetchKeyLog(req.db, [key.label], {
      since: key.created_at, until, limit, beforeId,
    });

    res.json({
      status: 'success',
      key: { id: key.id, label: key.label, created_at: key.created_at, revoked_at: key.revoked_at },
      window: { since: key.created_at, until },
      label_shared: Number(dupe?.n || 0) > 0,
      log,
      limit,
      next_before_id: log.length === limit ? log[log.length - 1].id : null,
    });
  } catch (err) {
    console.error(`GET /api/api-keys/${id}/log error:`, err);
    res.status(500).json({ status: 'error', message: 'Failed to load log' });
  }
});

module.exports = router;
module.exports._rotateInternal = rotateInternal; // exported for tests
