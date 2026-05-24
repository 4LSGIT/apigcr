// routes/api.scratch.js
//
// Cross-session key-value scratch store. Same auth as /api/readonly/sql
// (X-Readonly-Api-Key header — any active readonly key works).
//
// This route exposes only the WRITE surface:
//   PUT    /api/scratch/:ns/:k         upsert
//   DELETE /api/scratch/:ns/:k         delete one
//   DELETE /api/scratch/:ns?confirm=1  wipe namespace
//
// Reads go through /api/readonly/sql against the rw_scratch table —
// no separate read endpoint needed.
//
// Table-escape protection:
//   Every SQL statement in this file is a fixed string. The table name
//   is hardcoded. Dynamic input (ns, k, v, meta) is bound via mysql2
//   `?` placeholders, never interpolated. There is no API path from
//   caller input to arbitrary SQL or arbitrary tables.
//
// Audit:
//   Every operation (success + reject) logs to readonly_query_log
//   under the calling key — same table as /api/readonly/sql so the
//   admin UI's per-key log view shows a complete picture of what the
//   key did.

const express = require("express");
const router  = express.Router();
const { readonlyApiKeyAuth } = require("../lib/auth.readonly");

const NS_K_RE = /^[a-zA-Z0-9_\-]{1,64}$/;

const ipOf = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress;

function logOp(req, fields) {
  const sql = `
    INSERT INTO readonly_query_log
      (api_key_id, ip, user_agent, sql_text, params_json,
       row_count, duration_ms, status, error_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    req.auth?.keyId ?? null,
    ipOf(req),
    (req.headers["user-agent"] || "unknown").slice(0, 512),
    fields.sql_text ?? "",
    fields.params_json ? JSON.stringify(fields.params_json) : null,
    fields.row_count ?? null,
    fields.duration_ms ?? null,
    fields.status,
    fields.error_text ?? null,
  ];
  req.db.query(sql, params)
    .catch(err => console.error("[api.scratch] log insert failed:", err.message));
}

// ─── UPSERT ─────────────────────────────────────────────────────────
router.put("/api/scratch/:ns/:k", readonlyApiKeyAuth, async (req, res) => {
  const started = Date.now();
  const { ns, k } = req.params;
  const { v, meta } = req.body || {};

  if (!NS_K_RE.test(ns) || !NS_K_RE.test(k)) {
    logOp(req, {
      sql_text: "UPSERT rw_scratch", params_json: { ns, k },
      status: "rejected_invalid_ns_or_k", duration_ms: Date.now() - started,
    });
    return res.status(400).json({ error: "ns and k must match [A-Za-z0-9_-]{1,64}" });
  }

  // Reject objects/arrays for v — they'd coerce to "[object Object]" or
  // "1,2,3" via String(). Caller must JSON.stringify themselves so the
  // storage shape is explicit at the call site. Strings/numbers/booleans
  // pass through (String() coerces cleanly); null/undefined → NULL row.
  if (v !== undefined && v !== null && typeof v === "object") {
    logOp(req, {
      sql_text: "UPSERT rw_scratch", params_json: { ns, k },
      status: "rejected_v_not_string", duration_ms: Date.now() - started,
    });
    return res.status(400).json({
      error: "v must be a string, number, boolean, or null. " +
             "To store an object or array, JSON.stringify it first.",
    });
  }

  let metaJson = null;
  if (meta !== undefined && meta !== null) {
    try { metaJson = JSON.stringify(meta); }
    catch {
      return res.status(400).json({ error: "meta must be JSON-serializable" });
    }
  }
  const vStr = v == null ? null : String(v);

  try {
    const [r] = await req.db.query(
      `INSERT INTO rw_scratch (ns, k, v, meta)
            VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
            v    = VALUES(v),
            meta = VALUES(meta)`,
      [ns, k, vStr, metaJson]
    );

    // mysql2 affectedRows: 1 = INSERT, 2 = UPDATE, 0 = no change
    const created = r.affectedRows === 1;

    logOp(req, {
      sql_text: "INSERT … ON DUPLICATE KEY UPDATE rw_scratch",
      params_json: { ns, k, v_length: vStr?.length ?? null, has_meta: !!metaJson },
      row_count: r.affectedRows, duration_ms: Date.now() - started,
      status: "success",
    });

    res.json({ ok: true, ns, k, created, affectedRows: r.affectedRows });
  } catch (err) {
    logOp(req, {
      sql_text: "INSERT … ON DUPLICATE KEY UPDATE rw_scratch",
      params_json: { ns, k },
      duration_ms: Date.now() - started,
      status: "error", error_text: err.message,
    });
    res.status(400).json({ error: err.message, code: err.code || null });
  }
});

// ─── DELETE one ─────────────────────────────────────────────────────
router.delete("/api/scratch/:ns/:k", readonlyApiKeyAuth, async (req, res) => {
  const started = Date.now();
  const { ns, k } = req.params;

  if (!NS_K_RE.test(ns) || !NS_K_RE.test(k)) {
    logOp(req, {
      sql_text: "DELETE rw_scratch (one)", params_json: { ns, k },
      status: "rejected_invalid_ns_or_k", duration_ms: Date.now() - started,
    });
    return res.status(400).json({ error: "ns and k must match [A-Za-z0-9_-]{1,64}" });
  }

  try {
    const [r] = await req.db.query(
      `DELETE FROM rw_scratch WHERE ns = ? AND k = ?`,
      [ns, k]
    );
    logOp(req, {
      sql_text: "DELETE FROM rw_scratch WHERE ns=? AND k=?",
      params_json: { ns, k },
      row_count: r.affectedRows, duration_ms: Date.now() - started,
      status: "success",
    });
    res.json({ ok: true, deleted: r.affectedRows });
  } catch (err) {
    logOp(req, {
      sql_text: "DELETE FROM rw_scratch WHERE ns=? AND k=?",
      params_json: { ns, k },
      duration_ms: Date.now() - started,
      status: "error", error_text: err.message,
    });
    res.status(400).json({ error: err.message, code: err.code || null });
  }
});

// ─── DELETE namespace (confirm-gated) ───────────────────────────────
router.delete("/api/scratch/:ns", readonlyApiKeyAuth, async (req, res) => {
  const started = Date.now();
  const { ns } = req.params;

  if (!NS_K_RE.test(ns)) {
    return res.status(400).json({ error: "ns must match [A-Za-z0-9_-]{1,64}" });
  }
  if (req.query.confirm !== "1") {
    return res.status(400).json({ error: "Namespace-wide delete requires ?confirm=1" });
  }

  try {
    const [r] = await req.db.query(
      `DELETE FROM rw_scratch WHERE ns = ?`,
      [ns]
    );
    logOp(req, {
      sql_text: "DELETE FROM rw_scratch WHERE ns=?",
      params_json: { ns },
      row_count: r.affectedRows, duration_ms: Date.now() - started,
      status: "success",
    });
    res.json({ ok: true, deleted: r.affectedRows });
  } catch (err) {
    logOp(req, {
      sql_text: "DELETE FROM rw_scratch WHERE ns=?",
      params_json: { ns },
      duration_ms: Date.now() - started,
      status: "error", error_text: err.message,
    });
    res.status(400).json({ error: err.message, code: err.code || null });
  }
});

module.exports = router;