// routes/api.readonlyKeys.js
//
// Super-user-only management of SESSION KEYS — the ycro_-prefixed keys an
// AI session or script uses (ACCESS_CONTROL_DESIGN §5.3: "readonly key" was
// a misnomer — they reach read-only SQL, scratch, IT alerts and, by grant,
// the temp.* provider proxies). The prefix, the table (readonly_api_keys),
// the routes and the tool tag keep their old names; only the concept and the
// UI copy changed. The SU endpoints are gated via superuserOnlyFor("readonlyKeys") —
// JWT-authed humans only, no API-key bypass. The three /children endpoints are
// the one exception, and they are SESSION-KEY authed (below).
//
// FORMAT (B3): "ycro_" + 22 base62 chars (lib/apiKeys randomBase62, ~131
// bits) + "_" + an expiry stamp. Keys minted before B3 carry 64 hex chars and
// keep working: identity is the hash of whatever was minted.
//
// Endpoints:
//   POST   /api/readonly-keys          body { label, ttlMinutes?, scopes? }
//   GET    /api/readonly-keys          ?activeOnly=1 — also returns the scope
//                                      vocabulary + the mint default (the UI picker)
//   DELETE /api/readonly-keys/:id      revoke (sets revoked_at)
//   GET    /api/readonly-keys/:id/log  ?limit=N&offset=N
//   PATCH  /api/readonly-keys/:id      body { scopes } — full replace (D2)
//   POST   /api/readonly-keys/:id/renew body { ttlMinutes? } (D2)
//
// EDIT + RENEW (access-control D2, ACCESS_CONTROL_DESIGN §5.9): scopes and
// expiry are no longer frozen at mint. Both reuse the mint's rules (one copy,
// below: sessionScopes / rootTtlMinutes / childExpiresAt / childScopesWithin).
// Revocation is TERMINAL — every edit or renew of a revoked key is a 409; there
// is no un-revoke. A key is never set back to NULL scopes (a legacy key may
// leave NULL — the retrofit — never enter it). Adding sql.ro.sensitive needs
// ≤24h left (renew shorter first). A child's scopes stay within the trio. Every
// edit / renew is audited with before + after. Renew = now + ttl within the
// mint caps for the key's kind, 400 over a cap (the mint itself still clamps an
// ordinary over-long ask, as it always has), and works on an expired key.
//
// DELEGATION (access-control D1, ACCESS_CONTROL_DESIGN §5.8) — session-key
// authed (X-Readonly-Api-Key) + requireKeyScope('keys.mint'):
//   POST   /api/readonly-keys/children      body { label, ttlMinutes?, scopes? }
//   GET    /api/readonly-keys/children      the caller's own children
//   DELETE /api/readonly-keys/children/:id  revoke one of the caller's own children
//   POST   /api/readonly-keys/children/:id/renew  { ttlMinutes? } renew one (D2)
// A key holding keys.mint (SU-minted; explicit, so no legacy key holds it) mints
// CHILD keys for the sessions it manages. Delegation adds identities, never power:
//   - scopes ⊆ CHILD_SCOPES (sql.ro, scratch, alert) ∩ the parent's; omitted →
//     that whole intersection; anything else → 400 naming it (never dropped)
//   - expiry ≤ 24h AND ≤ the parent's; omitted → the smaller; over → 400
//   - 10 mints per rolling hour per parent, counted in the DB (Cloud Run runs
//     several instances) under a row lock on the parent → 429. No cap on live children.
//   - created_by = the parent's; parent_key_id = the parent's id; the plaintext
//     is returned once; mint + revoke audited (tool readonlyKeys, userId null)
//   - a child dies with its parent and its scopes narrow with it — lib/auth.readonly
//   - another key's child (or a missing id) → 404, never 403
// Paths: /children has more or fewer segments than every SU route (/:id,
// /:id/log), so neither family can swallow the other — tests/keyDelegation.test.js.
//
// SCOPES (access-control B1, ACCESS_CONTROL_DESIGN §5.1–5.2): a key may use
// only the surfaces in its scopes column (lib/auth.readonly requireKeyScope).
// A mint WITHOUT `scopes` gets DEFAULT_SCOPES = sql.ro + scratch + alert — the
// documented trio. NEW KEYS DO NOT GET temp.* (the credentialed provider
// proxies) by default: that is the point; name e.g. "temp.clio" explicitly.
// `scopes` is validated against lib/capabilities (surface list + route:/ and
// capability grammar); an unknown scope is a 400, never a silent drop. Keys
// minted before B1 have scopes NULL = the legacy full surface, untouched.
//
// SENSITIVE (SEC-3, ACCESS_CONTROL_DESIGN §5.7): a key whose scopes include
// sql.ro.sensitive (reads lib/sqlGuard SENSITIVE_TABLES) is mint-time capped —
// ttlMinutes over SENSITIVE_MAX_TTL_MIN (24h) is a 400, not a silent clamp;
// unspecified → SENSITIVE_DEFAULT_TTL_MIN (4h). It must carry sql.ro too (the
// endpoint's surface gate) — a 400 otherwise, never an implicit add.
//
// IP ALLOWLIST — RETIRED (D1, Fred's ruling 2026-10-15): the old
// ip_allowlist column was stored at mint and enforced nowhere, so holders
// believed in a restriction that did not exist. The column is dropped (stage 2
// of scripts/accessD1ParentKey.js, after this code deploys); a mint that still
// sends `ipAllowlist` is a 400, never a silent drop, so no caller keeps
// believing it does something. Nothing here reads or writes the column, so this
// code runs on the schema with or without it.
//
// Audit: key create/revoke goes to admin_audit_log via auditAdminAction
// under tool='readonlyKeys'. Plaintext key is NEVER logged anywhere.
// Plaintext is returned ONCE on create and never again.

const express = require("express");
const router  = express.Router();
const { superuserOnlyFor, auditAdminAction } = require("../lib/auth.superuser");
const { readonlyApiKeyAuth, requireKeyScope, hashKey } = require("../lib/auth.readonly");
const { normalizeKeyScopes, KEY_SCOPES, CHILD_SCOPES, keyAllows, scopesFromColumn } = require("../lib/capabilities");
const { randomBase62, KEY_BODY_LEN } = require("../lib/apiKeys");
const { withTransaction } = require("../lib/withTransaction");

const DEFAULT_SCOPES = Object.freeze(["sql.ro", "scratch", "alert"]);

const MAX_TTL_DAYS    = parseInt(process.env.READONLY_KEY_MAX_TTL_DAYS, 10) || 3;
const MAX_TTL_MINUTES = MAX_TTL_DAYS * 24 * 60;
const DEFAULT_TTL_MIN = 1440;  // 1 day

const SENSITIVE_SCOPE           = "sql.ro.sensitive";
const SENSITIVE_MAX_TTL_MIN     = 1440;  // 24h — not env-tunable
const SENSITIVE_DEFAULT_TTL_MIN = 240;   // 4h

const CHILD_MAX_TTL_MIN   = 1440;  // 24h — not env-tunable
const CHILD_MINTS_PER_HOUR = 10;   // per parent, rolling hour, DB-counted

const ipOf = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress;

// Compact UTC stamp (YYYYMMDDTHHMMZ) appended to the plaintext key, so a holder who
// has only the key string — a human, or an AI session handed the key with no other
// context — can tell whether it's dead without spending a request to find out.
//
// The stamp sits AFTER the second underscore, outside the key's hashed identity
// (only "ycro_<body>" is hashed — see canonicalKey in lib/auth.readonly). So the whole
// suffix is advisory and freely editable: a holder may rewrite the stamp, replace it
// with a human note, or drop it entirely and the key still authenticates. Forging the
// stamp later grants nothing — expiry is always enforced from the DB's expires_at, so
// the DB remains the sole source of truth. Seconds are truncated, so the stamp can read
// up to 59s earlier than the true expiry; erring early is the safe direction.
const stampExpiry = (d) => d.toISOString().replace(/[-:]/g, "").slice(0, 13) + "Z";

// The ONE key generator — SU mints and child mints both come through here.
// Body: 22 base62 chars (B3; lib/apiKeys). It has no underscore, so
// canonicalKey still cuts "ycro_<body>" off at the second underscore and the
// stamp stays an advisory suffix.
function generateSessionKey(expiresAt) {
  const raw = "ycro_" + randomBase62(KEY_BODY_LEN) + "_" + stampExpiry(expiresAt);
  return { raw, keyHash: hashKey(raw), keyPrefix: raw.slice(0, 12) };
}

// ─── THE RULES (one copy — mint, edit and renew all call these; D2) ────
// Each throws a Refusal carrying the HTTP status and body; the handlers only
// translate. Revocation is TERMINAL: no edit or renew ever touches a revoked key.

class Refusal extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const send = (res, err) => res.status(err.status).json(err.body);
const REVOKED = () => new Refusal(409, { error: "revoked keys stay revoked — mint a new one" });

/** A session key's scope list (mint or edit): normalized; sensitive needs sql.ro. */
function sessionScopes(list) {
  let scopes;
  try { scopes = normalizeKeyScopes(list); }
  catch (err) { throw new Refusal(400, { error: err.message }); }
  if (scopes.includes(SENSITIVE_SCOPE) && !scopes.includes("sql.ro")) {
    throw new Refusal(400, { error: `${SENSITIVE_SCOPE} needs sql.ro too — it widens the SQL surface, it does not grant it` });
  }
  return scopes;
}

/**
 * A ROOT session key's lifetime in minutes. Sensitive: ≤ 24h (default 4h), over
 * = 400. Ordinary: default 1 day; over MAX_TTL_MINUTES the MINT clamps (its
 * behaviour since before D2, kept) while a RENEW (strict) refuses — the D2
 * ruling is "over a cap → 400, never a clamp". Strict also refuses junk, which
 * the mint reads as "not given".
 */
function rootTtlMinutes(ttlMinutes, { sensitive, strict }) {
  let given = false, requested;
  if (strict) {
    if (ttlMinutes !== undefined && ttlMinutes !== null) {
      requested = Number(ttlMinutes);
      if (!Number.isInteger(requested) || requested <= 0) {
        throw new Refusal(400, { error: "ttlMinutes must be a positive whole number of minutes" });
      }
      given = true;
    }
  } else {
    requested = parseInt(ttlMinutes, 10);
    given = Number.isFinite(requested) && requested > 0;
  }
  if (sensitive) {
    if (given && requested > SENSITIVE_MAX_TTL_MIN) {
      throw new Refusal(400, {
        error: `a ${SENSITIVE_SCOPE} key lives at most ${SENSITIVE_MAX_TTL_MIN} minutes (24h); asked for ${requested}`,
        maxTtlMinutes: SENSITIVE_MAX_TTL_MIN,
      });
    }
    return given ? requested : SENSITIVE_DEFAULT_TTL_MIN;
  }
  if (!given) return DEFAULT_TTL_MIN;
  if (requested > MAX_TTL_MINUTES) {
    if (strict) {
      throw new Refusal(400, {
        error: `a session key lives at most ${MAX_TTL_MINUTES} minutes (${MAX_TTL_DAYS} days); asked for ${requested}`,
        maxTtlMinutes: MAX_TTL_MINUTES,
      });
    }
    return MAX_TTL_MINUTES;
  }
  return requested;
}

/**
 * A CHILD key's expiry (mint or renew): ≤ 24h AND ≤ its parent's; omitted →
 * the smaller; over either → 400. Whole seconds (DATETIME would ROUND a
 * fraction, which could carry a child a second past its parent).
 */
function childExpiresAt(ttlMinutes, parentExpMs, now = Date.now()) {
  if (!(parentExpMs > now)) {
    throw new Refusal(400, {
      error: "the parent key has expired — a child cannot outlive it",
      parentExpiresAt: Number.isFinite(parentExpMs) ? new Date(parentExpMs).toISOString() : null,
    });
  }
  let expiresMs;
  if (ttlMinutes === undefined || ttlMinutes === null) {
    expiresMs = Math.min(now + CHILD_MAX_TTL_MIN * 60_000, parentExpMs);
  } else {
    const t = Number(ttlMinutes);
    if (!Number.isInteger(t) || t <= 0) {
      throw new Refusal(400, { error: "ttlMinutes must be a positive whole number of minutes" });
    }
    if (t > CHILD_MAX_TTL_MIN) {
      throw new Refusal(400, { error: `a child key lives at most ${CHILD_MAX_TTL_MIN} minutes (24h); asked for ${t}`, maxTtlMinutes: CHILD_MAX_TTL_MIN });
    }
    expiresMs = now + t * 60_000;
    if (expiresMs > parentExpMs) {
      throw new Refusal(400, {
        error: `a child key cannot outlive its parent — the parent expires ${new Date(parentExpMs).toISOString()}`,
        parentExpiresAt: new Date(parentExpMs).toISOString(),
      });
    }
  }
  return new Date(Math.floor(expiresMs / 1000) * 1000);
}

/** A child's scopes must stay within the trio (and, at mint, within what the parent holds). */
function childScopesWithin(scopes, allowed) {
  const offending = scopes.filter(s => !allowed.includes(s));
  if (offending.length) {
    throw new Refusal(400, {
      error: `scope(s) not delegable: ${offending.join(", ")} — a child key may hold only ${allowed.join(", ") || "nothing"} (${CHILD_SCOPES.join(", ")}${allowed.length < CHILD_SCOPES.length ? " that its parent holds" : ""})`,
      offendingScopes: offending,
      delegableScopes: allowed,
    });
  }
}

// ─── CHILD KEYS (D1) ─────────────────────────────────────────────────
// Registered BEFORE the SU /:id routes (belt — the segment counts already differ).

const childAudit = (req, status, details, started) =>
  auditAdminAction(req.db, {
    tool: "readonlyKeys",
    userId: null,
    username: null,
    route: req.originalUrl,
    method: req.method,
    status,
    durationMs: Date.now() - started,
    ip: ipOf(req),
    userAgent: req.headers["user-agent"] || "unknown",
    details,
  }).catch(err => console.error("[readonlyKeys] child audit failed:", err.message));

// A child can never reach these (it cannot hold keys.mint — childEffectiveScopes);
// this asserts it anyway, on the caller's auth and again on its locked row.
function refuseChildCaller(req, res) {
  if (req.auth.parentKeyId == null) return false;
  res.status(403).json({ error: "A child key cannot manage keys" });
  return true;
}

router.post("/api/readonly-keys/children", readonlyApiKeyAuth, requireKeyScope("keys.mint"), async (req, res) => {
  const started = Date.now();
  if (refuseChildCaller(req, res)) return;
  const parentId = req.auth.keyId;
  const { label, ttlMinutes, scopes: scopesIn } = req.body || {};

  if (!label || typeof label !== "string" || !label.trim()) {
    return res.status(400).json({ error: "label is required" });
  }
  const trimmedLabel = label.trim().slice(0, 255);

  // Scopes: ⊆ CHILD_SCOPES ∩ what the parent holds (req.auth.scopes — a root key's own).
  const delegable = CHILD_SCOPES.filter(s => keyAllows(req.auth, s));
  let scopes, expiresAt;
  try {
    if (scopesIn === undefined) {
      if (!delegable.length) {
        throw new Refusal(400, { error: `this key holds none of ${CHILD_SCOPES.join(", ")} — nothing to delegate` });
      }
      scopes = delegable;
    } else {
      try { scopes = normalizeKeyScopes(scopesIn); }
      catch (err) { throw new Refusal(400, { error: err.message, delegableScopes: delegable }); }
      childScopesWithin(scopes, delegable);
    }
    expiresAt = childExpiresAt(ttlMinutes, req.auth.expiresAt.getTime());
  } catch (err) {
    if (err instanceof Refusal) return send(res, err);
    throw err;
  }
  const { raw, keyHash, keyPrefix } = generateSessionKey(expiresAt);

  let childId;
  try {
    childId = await withTransaction(req.db, async (conn) => {
      // Row lock on the parent serialises its concurrent mints, so the count is exact.
      const [[parent]] = await conn.query(
        `SELECT id, created_by, revoked_at, parent_key_id
           FROM readonly_api_keys WHERE id = ? FOR UPDATE`, [parentId]);
      if (!parent || parent.revoked_at) {
        throw new Refusal(401, { error: "Readonly API key revoked" });
      }
      if (parent.parent_key_id != null) {
        throw new Refusal(403, { error: "A child key cannot manage keys" });
      }
      const [[{ n }]] = await conn.query(
        `SELECT COUNT(*) AS n FROM readonly_api_keys
          WHERE parent_key_id = ? AND created_at > NOW() - INTERVAL 1 HOUR`, [parentId]);
      if (Number(n) >= CHILD_MINTS_PER_HOUR) {
        throw new Refusal(429, {
          error: `Rate limit: ${CHILD_MINTS_PER_HOUR} child keys per rolling hour per parent key`,
          limit: CHILD_MINTS_PER_HOUR,
        });
      }
      const [r] = await conn.query(
        `INSERT INTO readonly_api_keys
           (key_hash, key_prefix, label, created_by, expires_at, scopes, parent_key_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [keyHash, keyPrefix, trimmedLabel, parent.created_by, expiresAt, JSON.stringify(scopes), parentId]);
      return r.insertId;
    });
  } catch (err) {
    if (err instanceof Refusal) {
      if (err.status === 429) {
        await childAudit(req, "rejected_child_rate_limit", { parentKeyId: parentId, limit: CHILD_MINTS_PER_HOUR }, started);
      }
      return res.status(err.status).json(err.body);
    }
    console.error("POST /api/readonly-keys/children error:", err);
    return res.status(500).json({ error: err.message });
  }

  await childAudit(req, "child_created", {
    parentKeyId: parentId, childKeyId: childId, label: trimmedLabel, scopes, expiresAt: expiresAt.toISOString(),
  }, started);

  // Plaintext returned ONCE here and never again.
  res.json({ ok: true, id: childId, key: raw, keyPrefix, label: trimmedLabel, expiresAt: expiresAt.toISOString(), scopes });
});

router.get("/api/readonly-keys/children", readonlyApiKeyAuth, requireKeyScope("keys.mint"), async (req, res) => {
  if (refuseChildCaller(req, res)) return;
  try {
    const [rows] = await req.db.query(
      `SELECT id, label, key_prefix, scopes, created_at, expires_at, revoked_at, last_used_at, use_count
         FROM readonly_api_keys
        WHERE parent_key_id = ?
        ORDER BY id DESC
        LIMIT 200`, [req.auth.keyId]);
    res.json({ ok: true, children: rows });
  } catch (err) {
    console.error("GET /api/readonly-keys/children error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/readonly-keys/children/:id", readonlyApiKeyAuth, requireKeyScope("keys.mint"), async (req, res) => {
  const started = Date.now();
  if (refuseChildCaller(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    // Keyed on the caller too: another key's child matches nothing — a 404
    // indistinguishable from a missing id (existence is never confirmed).
    const [r] = await req.db.query(
      `UPDATE readonly_api_keys SET revoked_at = NOW()
        WHERE id = ? AND parent_key_id = ? AND revoked_at IS NULL`, [id, req.auth.keyId]);
    if (!r.affectedRows) {
      return res.status(404).json({ error: "Not found or already revoked" });
    }
    const [[row]] = await req.db.query(
      `SELECT scopes, expires_at FROM readonly_api_keys WHERE id = ?`, [id]);
    await childAudit(req, "child_revoked", {
      parentKeyId: req.auth.keyId, childKeyId: id,
      scopes: row ? row.scopes : null,
      expiresAt: row ? new Date(row.expires_at).toISOString() : null,
    }, started);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/readonly-keys/children/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// A parent renews its OWN child (D2) within the child caps. A key is never its
// own child, so a self-renew is the same 404 as a foreign or missing id.
router.post("/api/readonly-keys/children/:id/renew", readonlyApiKeyAuth, requireKeyScope("keys.mint"), async (req, res) => {
  const started = Date.now();
  if (refuseChildCaller(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const [[row]] = await req.db.query(
      `SELECT id, expires_at, revoked_at FROM readonly_api_keys WHERE id = ? AND parent_key_id = ?`,
      [id, req.auth.keyId]);
    if (!row) throw new Refusal(404, { error: "Not found" });
    if (row.revoked_at) throw REVOKED();
    const expiresAt = childExpiresAt((req.body || {}).ttlMinutes, req.auth.expiresAt.getTime());
    const [r] = await req.db.query(
      `UPDATE readonly_api_keys SET expires_at = ?
        WHERE id = ? AND parent_key_id = ? AND revoked_at IS NULL`, [expiresAt, id, req.auth.keyId]);
    if (!r.affectedRows) throw REVOKED();
    await childAudit(req, "child_renewed", {
      parentKeyId: req.auth.keyId, childKeyId: id,
      before: { expiresAt: new Date(row.expires_at).toISOString() },
      after: { expiresAt: expiresAt.toISOString() },
    }, started);
    res.json({ ok: true, id, expiresAt: expiresAt.toISOString(), expiresStamp: stampExpiry(expiresAt) });
  } catch (err) {
    if (err instanceof Refusal) return send(res, err);
    console.error("POST /api/readonly-keys/children/:id/renew error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── CREATE ──────────────────────────────────────────────────────────
router.post("/api/readonly-keys", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const started = Date.now();
  const body = req.body || {};
  const { label, ttlMinutes, scopes: scopesIn } = body;

  if (!label || typeof label !== "string" || !label.trim()) {
    return res.status(400).json({ error: "label is required" });
  }
  if ("ipAllowlist" in body) {
    return res.status(400).json({ error: "ipAllowlist is retired — it was never enforced; a session key is not IP-restricted" });
  }

  let scopes, ttl;
  try {
    scopes = scopesIn === undefined ? [...DEFAULT_SCOPES] : sessionScopes(scopesIn);
    ttl = rootTtlMinutes(ttlMinutes, { sensitive: scopes.includes(SENSITIVE_SCOPE), strict: false });
  } catch (err) {
    if (err instanceof Refusal) return send(res, err);
    throw err;
  }
  const trimmedLabel = label.trim().slice(0, 255);

  // Must precede the key — the key carries this value as its suffix and the two have
  // to agree. Note ttl here is the *clamped* value, so an over-long request can't mint
  // a key advertising an expiry the DB won't honor.
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  const { raw, keyHash, keyPrefix } = generateSessionKey(expiresAt);

  try {
    const [r] = await req.db.query(
      `INSERT INTO readonly_api_keys
         (key_hash, key_prefix, label, created_by, expires_at, scopes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [keyHash, keyPrefix, trimmedLabel, req.auth.userId, expiresAt, JSON.stringify(scopes)]
    );

    await auditAdminAction(req.db, {
      tool: "readonlyKeys",
      userId: req.auth.userId,
      username: req.auth.username,
      route: req.originalUrl,
      method: req.method,
      status: "created",
      durationMs: Date.now() - started,
      ip: ipOf(req),
      userAgent: req.headers["user-agent"] || "unknown",
      details: {
        key_id: r.insertId,
        key_prefix: keyPrefix,
        label: trimmedLabel,
        ttl_minutes: ttl,
        expires_at: expiresAt.toISOString(),
        scopes,
      },
    });

    // Plaintext returned ONCE here and never again.
    res.json({
      ok: true,
      id: r.insertId,
      key: raw,
      keyPrefix,
      label: trimmedLabel,
      expiresAt: expiresAt.toISOString(),
      ttlMinutes: ttl,
      scopes,
    });
  } catch (err) {
    console.error("POST /api/readonly-keys error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── LIST ────────────────────────────────────────────────────────────
router.get("/api/readonly-keys", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const activeOnly = ["1", "true", "yes"].includes(String(req.query.activeOnly || "").toLowerCase());
  try {
    // Active = the key's own state AND, for a child (D1), its parent's — a
    // child of a revoked/expired parent is dead at auth, so it is not active here.
    const where = activeOnly
      ? `WHERE k.revoked_at IS NULL AND k.expires_at > NOW()
           AND (k.parent_key_id IS NULL OR (p.id IS NOT NULL AND p.revoked_at IS NULL AND p.expires_at > NOW()))`
      : "";
    const [rows] = await req.db.query(
      `SELECT k.id, k.key_prefix, k.label, k.created_by, u.username AS created_by_username,
              k.created_at, k.expires_at, k.revoked_at, k.last_used_at, k.use_count,
              k.scopes, k.parent_key_id, p.label AS parent_label,
              p.revoked_at AS parent_revoked_at, p.expires_at AS parent_expires_at
         FROM readonly_api_keys k
         LEFT JOIN users u ON u.user = k.created_by
         LEFT JOIN readonly_api_keys p ON p.id = k.parent_key_id
         ${where}
        ORDER BY k.id DESC
        LIMIT 200`
    );
    res.json({
      ok: true, keys: rows, max_ttl_days: MAX_TTL_DAYS,
      // The picker's source (B3): the surface vocabulary and the default trio,
      // so the page never carries its own copy of either.
      // `explicit` (D2): what a legacy NULL key does NOT hold — the edit dialog's
      // starting point for a retrofit is the legacy surface, i.e. the rest.
      scope_vocabulary: Object.entries(KEY_SCOPES).map(([name, v]) => ({ name, desc: v.desc, ...(v.explicit ? { explicit: true } : {}) })),
      default_scopes: DEFAULT_SCOPES,
      // SEC-3: the sensitive scope and its mint cap, so the page renders the
      // box apart and caps the TTL field from the server's numbers.
      sensitive_scope: { name: SENSITIVE_SCOPE, max_ttl_minutes: SENSITIVE_MAX_TTL_MIN, default_ttl_minutes: SENSITIVE_DEFAULT_TTL_MIN },
      // D2: the edit dialog's child picker and the renew dialog's caps.
      child_scopes: CHILD_SCOPES,
      ttl: { max_minutes: MAX_TTL_MINUTES, default_minutes: DEFAULT_TTL_MIN, child_max_minutes: CHILD_MAX_TTL_MIN },
    });
  } catch (err) {
    console.error("GET /api/readonly-keys error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── REVOKE ──────────────────────────────────────────────────────────
router.delete("/api/readonly-keys/:id", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const started = Date.now();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const [r] = await req.db.query(
      `UPDATE readonly_api_keys
          SET revoked_at = NOW()
        WHERE id = ? AND revoked_at IS NULL`,
      [id]
    );

    if (!r.affectedRows) {
      return res.status(404).json({ error: "Not found or already revoked" });
    }

    await auditAdminAction(req.db, {
      tool: "readonlyKeys",
      userId: req.auth.userId,
      username: req.auth.username,
      route: req.originalUrl,
      method: req.method,
      status: "revoked",
      durationMs: Date.now() - started,
      ip: ipOf(req),
      userAgent: req.headers["user-agent"] || "unknown",
      details: { key_id: id },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/readonly-keys/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── EDIT SCOPES / RENEW (D2) ────────────────────────────────────────
// SU only. Revocation is terminal: a revoked key is a 409 on both. Neither
// ever writes another row — editing a parent narrows (or, on its next edit,
// re-widens) its children through D1's per-request intersection.

async function loadForEdit(db, id) {
  const [[row]] = await db.query(
    `SELECT k.id, k.scopes, k.expires_at, k.revoked_at, k.parent_key_id,
            p.expires_at AS parent_expires_at, p.revoked_at AS parent_revoked_at
       FROM readonly_api_keys k
       LEFT JOIN readonly_api_keys p ON p.id = k.parent_key_id
      WHERE k.id = ?`, [id]);
  if (!row) throw new Refusal(404, { error: "Not found" });
  if (row.revoked_at) throw REVOKED();
  return row;
}

const suAudit = (req, status, details, started) =>
  auditAdminAction(req.db, {
    tool: "readonlyKeys",
    userId: req.auth.userId,
    username: req.auth.username,
    route: req.originalUrl,
    method: req.method,
    status,
    durationMs: Date.now() - started,
    ip: ipOf(req),
    userAgent: req.headers["user-agent"] || "unknown",
    details,
  });

const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new Refusal(400, { error: "Invalid id" });
  return id;
};

// PATCH { scopes } — a FULL replacement. A legacy NULL key may be given scopes
// (the retrofit); no key is ever set back to NULL.
router.patch("/api/readonly-keys/:id", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const started = Date.now();
  try {
    const id = idParam(req);
    const { scopes: scopesIn } = req.body || {};
    if (scopesIn === undefined || scopesIn === null) {
      throw new Refusal(400, { error: "scopes is required — the full new list; a key is never set back to NULL (the legacy full surface)" });
    }
    const scopes = sessionScopes(scopesIn);
    const row = await loadForEdit(req.db, id);
    const before = scopesFromColumn(row.scopes);
    if (row.parent_key_id != null) childScopesWithin(scopes, CHILD_SCOPES);

    const hadSensitive = Array.isArray(before) && before.includes(SENSITIVE_SCOPE);
    if (scopes.includes(SENSITIVE_SCOPE) && !hadSensitive) {
      const leftMin = Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 60_000);
      if (leftMin > SENSITIVE_MAX_TTL_MIN) {
        throw new Refusal(400, {
          error: `${SENSITIVE_SCOPE} needs a key with at most ${SENSITIVE_MAX_TTL_MIN} minutes (24h) left; this one has ${leftMin} — renew it shorter first: POST /api/readonly-keys/${id}/renew { ttlMinutes ≤ ${SENSITIVE_MAX_TTL_MIN} }`,
          renewRoute: `/api/readonly-keys/${id}/renew`,
          maxTtlMinutes: SENSITIVE_MAX_TTL_MIN,
        });
      }
    }

    const [r] = await req.db.query(
      `UPDATE readonly_api_keys SET scopes = ? WHERE id = ? AND revoked_at IS NULL`, [JSON.stringify(scopes), id]);
    if (!r.affectedRows) throw REVOKED();

    const notes = [];
    const hadMint = Array.isArray(before) && before.includes("keys.mint");
    if (hadMint && !scopes.includes("keys.mint")) {
      const [[{ n }]] = await req.db.query(
        `SELECT COUNT(*) AS n FROM readonly_api_keys
          WHERE parent_key_id = ? AND revoked_at IS NULL AND expires_at > NOW()`, [id]);
      notes.push(`keys.mint removed: ${Number(n)} live child key(s) keep working, without a manager — `
        + `they can no longer be renewed or revoked by this key, still die with it, and the SU can revoke them here`);
    }
    await suAudit(req, "scopes_edited", { key_id: id, before: { scopes: before }, after: { scopes } }, started);
    res.json({ ok: true, id, scopes, before, ...(notes.length ? { notes } : {}) });
  } catch (err) {
    if (err instanceof Refusal) return send(res, err);
    console.error("PATCH /api/readonly-keys/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST { ttlMinutes? } — new expires_at = now + ttl, within the MINT caps for
// this key's kind (ordinary / sensitive / child); over a cap is a 400, never a
// clamp. Works on an expired, unrevoked key. The key's advisory stamp goes
// stale: the reply carries expiresStamp so the holder can rewrite its suffix.
router.post("/api/readonly-keys/:id/renew", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const started = Date.now();
  try {
    const id = idParam(req);
    const { ttlMinutes } = req.body || {};
    const row = await loadForEdit(req.db, id);
    let expiresAt;
    if (row.parent_key_id != null) {
      if (row.parent_revoked_at) {
        throw new Refusal(409, { error: "its parent key is revoked, so this child is dead for good — mint a new one" });
      }
      expiresAt = childExpiresAt(ttlMinutes, new Date(row.parent_expires_at).getTime());
    } else {
      const own = scopesFromColumn(row.scopes);
      const ttl = rootTtlMinutes(ttlMinutes, { sensitive: Array.isArray(own) && own.includes(SENSITIVE_SCOPE), strict: true });
      expiresAt = new Date(Math.floor((Date.now() + ttl * 60_000) / 1000) * 1000);
    }
    const [r] = await req.db.query(
      `UPDATE readonly_api_keys SET expires_at = ? WHERE id = ? AND revoked_at IS NULL`, [expiresAt, id]);
    if (!r.affectedRows) throw REVOKED();
    await suAudit(req, "renewed", {
      key_id: id,
      before: { expires_at: new Date(row.expires_at).toISOString() },
      after: { expires_at: expiresAt.toISOString() },
    }, started);
    res.json({ ok: true, id, expiresAt: expiresAt.toISOString(), expiresStamp: stampExpiry(expiresAt) });
  } catch (err) {
    if (err instanceof Refusal) return send(res, err);
    console.error("POST /api/readonly-keys/:id/renew error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PER-KEY QUERY LOG ───────────────────────────────────────────────
router.get("/api/readonly-keys/:id/log", ...superuserOnlyFor("readonlyKeys"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid id" });
  }
  const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit, 10)  || 100));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  try {
    const [rows] = await req.db.query(
      `SELECT id, created_at, ip, sql_text, params_json,
              row_count, duration_ms, status, error_text
         FROM readonly_query_log
        WHERE api_key_id = ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
      [id, limit, offset]
    );
    res.json({ ok: true, log: rows, limit, offset });
  } catch (err) {
    console.error("GET /api/readonly-keys/:id/log error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.DEFAULT_SCOPES = DEFAULT_SCOPES;
module.exports.SENSITIVE_MAX_TTL_MIN = SENSITIVE_MAX_TTL_MIN;
module.exports.SENSITIVE_DEFAULT_TTL_MIN = SENSITIVE_DEFAULT_TTL_MIN;
module.exports.CHILD_MAX_TTL_MIN = CHILD_MAX_TTL_MIN;
module.exports.CHILD_MINTS_PER_HOUR = CHILD_MINTS_PER_HOUR;
// The shared rules (D2), for their unit tests.
module.exports._rules = { Refusal, sessionScopes, rootTtlMinutes, childExpiresAt, childScopesWithin, stampExpiry };