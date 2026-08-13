// routes/api.reports.js
//
/**
 * routes/api.reports.js — REST routes for the reports engine (Slice 1).
 *
 * GET    /api/reports                        — list active reports (?all=1 inactive too, ?kind=view|report to filter)
 * GET    /api/reports/schema                 — curated manifest summary (what reports can see)
 * GET    /api/reports/runs                   — recent run history across all reports
 * POST   /api/reports/draft                  — question (or report_id + instruction) → validated draft (rate-limited)
 * POST   /api/reports/preview                — validate + run an unsaved definition, never persisted (rate-limited)
 * GET    /api/reports/:id                    — full definition incl. sql_text
 * POST   /api/reports/:id/run                — run it; body { params: {...} }
 * GET    /api/reports/:id/runs               — run history for one report
 * GET    /api/reports/:id/versions           — version history (metadata only)
 * GET    /api/reports/:id/versions/:v        — one archived version, full payload
 * POST   /api/reports/:id/versions/:v/restore— restore that version over the live definition
 * POST   /api/reports/:id/lock               — lock / unlock; body { locked: boolean }
 * POST   /api/reports                        — create
 * PUT    /api/reports/:id                    — update (report_key immutable; snapshots first)
 * DELETE /api/reports/:id                    — delete (snapshots first)
 *
 * Auto-mounted from routes/ (server.js readdir loop).
 *
 * ── AUTH (S3) ───────────────────────────────────────────────────────────────
 * All routes require JWT or API key. Read + run are open to any authorised
 * caller, INCLUDING API-key callers, so workflow HTTP calls keep working.
 * Writes (create / update / delete / restore / lock / draft / preview)
 * require a JWT with a userId — requireUser below. API-key callers get 403
 * on writes exactly as requireSU 403'd them before, so this is not a
 * widening; what changed is that ANY logged-in user may author, not just an
 * SU. The per-row protection that replaces the SU gate is the LOCK, and it
 * is enforced in services/reportService.js (assertEditable / setLock) — one
 * enforcement point covering HTTP and machine callers both. The routes'
 * only jobs are identity (requireUser → actorOf) and rate limits.
 *
 * ── ORDERING ────────────────────────────────────────────────────────────────
 * The literal-segment routes (/schema, /runs) are registered BEFORE /:id so
 * those words can never be read as an id.
 *
 * Response envelope: { status:'success', ... } | { status:'error', message, detail? }
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const svc = require("../services/reportService");
const authorSvc = require("../services/reportAuthorService");
const manifest = require("../lib/reportSchema/manifest");
const { makeLimiter } = require("../lib/rateLimiter");

function fail(res, tag, e) {
  const status = e.status || 500;
  if (status >= 500) console.error(`[api.reports] ${tag} error:`, e);
  const body = { status: "error", message: e.message };
  if (e.detail) body.detail = e.detail;
  res.status(status).json(body);
}

const userId = (req) => (req.auth && req.auth.userId != null ? req.auth.userId : null);

/**
 * Writes require an authenticated JWT WITH a userId. That is every logged-in
 * staff member — the SU gate is gone (S3); the per-row protection that
 * replaces it is the lock, enforced in the service. API-key callers are
 * 403'd here exactly as requireSU 403'd them, so machine read/run access is
 * unchanged and machine writes remain blocked at the HTTP surface.
 *
 * Gates: create, update, delete, restore, lock, draft, preview.
 */
function requireUser(req, res, next) {
  if (req.auth && req.auth.type === "jwt" && req.auth.userId != null) {
    return next();
  }
  return res.status(403).json({
    status: "error",
    message: "Writing a report definition requires a logged-in user.",
    detail: "API keys can read and run saved reports, but authoring is tied to a person.",
  });
}

/**
 * Build the service actor for a write. Only ever called behind requireUser,
 * so req.auth is a JWT with a userId — which may be a STRING (auth.login
 * signs sub: user.user; string subs are observed in the wild), and the
 * service's normalizeActor parses it. user_auth === "authorized - SU" is the
 * lock-bypass flag.
 */
function actorOf(req) {
  if (!req.auth || req.auth.type !== "jwt") return svc.SYSTEM_ACTOR; // unreachable behind requireUser
  return svc.normalizeActor(req.auth.userId, req.auth.user_auth === "authorized - SU");
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate limits — draft 30/hour, preview 60/hour, keyed on String(userId).
//
// NOT keyed on IP: all four staff sit behind one office connection, so an
// IP-keyed limiter would let one person's drafting spree lock out the firm
// (and lib/rateLimiter's own notes show req.ip is a constant on this chain
// anyway). requireUser runs first, so every caller here has a userId.
// Buckets are per-instance process memory (effective cap = max × instance
// count) — accepted best-effort, same posture as every other limiter here.
// ─────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const draftLimited = makeLimiter(HOUR_MS, 30);
const previewLimited = makeLimiter(HOUR_MS, 60);

function limitDraft(req, res, next) {
  if (draftLimited(String(req.auth.userId))) {
    return res.status(429).json({
      status: "error",
      message: "You've asked the AI for a lot of drafts in the past hour.",
      detail: "The limit is 30 drafts per person per hour — it resets on its own. If you're iterating on SQL, the editor's Validate & preview doesn't use the AI.",
    });
  }
  next();
}

function limitPreview(req, res, next) {
  if (previewLimited(String(req.auth.userId))) {
    return res.status(429).json({
      status: "error",
      message: "You've previewed a lot of unsaved SQL in the past hour.",
      detail: "The limit is 60 previews per person per hour — it resets on its own. Saved reports can be run as often as you like.",
    });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Literal segments first
// ─────────────────────────────────────────────────────────────────────────────

router.get("/api/reports/schema", jwtOrApiKey, (req, res) => {
  try {
    res.json({
      status: "success",
      tables: manifest.summary(),
      globalNotes: manifest.GLOBAL_NOTES,
      deniedColumns: manifest.DENIED_COLUMNS,
    });
  } catch (e) {
    fail(res, "schema", e);
  }
});

router.get("/api/reports/runs", jwtOrApiKey, async (req, res) => {
  try {
    const runs = await svc.listRuns(req.db, { limit: req.query.limit });
    res.json({ status: "success", runs });
  } catch (e) {
    fail(res, "runs", e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reports/draft — AI author (any logged-in user; rate-limited)
//
// Body: { question?, report_id?, previous?, instruction? }
//   question    plain-English request (new definition)
//   report_id   refine a SAVED definition — the base is loaded from the DB here
//   previous    refine an UNSAVED draft the UI is holding — base comes from the
//               client, because there is nothing to load
//   instruction what to change ("add a year filter")
//
// report_id WINS over previous. The base for a saved definition is read
// server-side rather than trusted from the request: the client's copy can be
// stale, and a stale base is how you get a "refine" that silently reverts
// somebody else's edit. It also means the refine cannot be used to smuggle SQL
// past the base — but note that is not a security boundary anyway, since
// /preview already accepts arbitrary SU-authored SQL by design.
//
// Returns one of three outcomes, all HTTP 200 — none of these is a server
// error, and the UI renders each differently:
//   { outcome:'drafted', definition, base, baseId, preview, attempts, repairs, usage }
//   { outcome:'refused', reason, suggestion, baseId }   ← data can't answer it
//   { outcome:'invalid', definition, baseId, error, detail, attempts }
//
// Nothing is persisted. baseId tells the UI whether Save means POST (new) or
// PUT (update in place); both re-validate on the way in, and PUT snapshots the
// outgoing version first.
//
// LOCK CHECK RUNS BEFORE THE AI CALL — on both refine shapes. A refine whose
// eventual save would 403 must be refused HERE, not after burning a paid
// model call: for report_id the loaded base is checked directly; for an
// unsaved `previous` that carries an id (the UI threads the PUT target as
// previous.id across iterate turns), that saved row is loaded and checked
// too. A previous.id pointing at a since-deleted row is NOT fatal — the
// draft proceeds as a new definition, exactly what the eventual save does.
// ─────────────────────────────────────────────────────────────────────────────

router.post("/api/reports/draft", jwtOrApiKey, requireUser, limitDraft, async (req, res) => {
  try {
    const { question, report_id, previous, instruction } = req.body || {};
    const actor = actorOf(req);

    let base = null;
    if (report_id != null && String(report_id).trim() !== "") {
      const id = Number(report_id);
      if (!Number.isInteger(id) || id <= 0) {
        throw Object.assign(new Error("report_id must be a positive integer"), { status: 400 });
      }
      base = await svc.getReport(req.db, id);   // 404s if it isn't there
      svc.assertEditable(base, actor);          // 403 BEFORE the AI call
    } else if (previous && typeof previous === "object") {
      base = previous;                          // unsaved draft; no id
      const prevId = Number(previous.id);
      if (Number.isInteger(prevId) && prevId > 0) {
        try {
          const saved = await svc.getReport(req.db, prevId);
          svc.assertEditable(saved, actor);     // 403 BEFORE the AI call
        } catch (e) {
          if (e.status === 403) throw e;        // locked → refuse now
          // 404 → the saved base is gone; draft on as a new definition.
        }
      }
    }

    const result = await authorSvc.draft(req.db, {
      question, base, instruction, userId: userId(req),
    });
    res.json({ status: "success", ...result });
  } catch (e) {
    fail(res, "draft", e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reports/preview — run an UNSAVED definition (any logged-in user;
// rate-limited)
//
// Body: { sql_text, params?, paramValues?, row_limit? }
//
// Validated by exactly the same validator as a saved report, executed on the
// same SELECT-only pool, and logged to report_runs with report_id NULL.
// Nothing is written to report_definitions.
//
// SECURITY NOTE (updated for S3): this accepts SQL from any logged-in user.
// That is a real widening relative to the SU-only version, and it is the
// deliberate one this slice makes: the SQL still passes the manifest
// allowlist, the column denylist, the EXPLAIN gate and the 20s timeout, and
// executes as the SELECT-only MySQL user — the same guards that make SAVED
// reports safe for everyone to run make UNSAVED ones safe for everyone to
// preview. What a preview can read is exactly what any saved report could
// already show the same user. The per-user rate limit bounds the annoyance
// ceiling (runaway EXPLAIN-passing queries are still 20s each).
// ─────────────────────────────────────────────────────────────────────────────

router.post("/api/reports/preview", jwtOrApiKey, requireUser, limitPreview, async (req, res) => {
  try {
    const { sql_text, params = [], paramValues = {}, row_limit } = req.body || {};
    if (!sql_text || !String(sql_text).trim()) {
      throw Object.assign(new Error("sql_text is required"), { status: 400 });
    }

    const values = svc.buildBindValues(params, paramValues);
    const result = await svc.execute(req.db, {
      sql: sql_text,
      values,
      rowLimit: row_limit || 100,
      expectedParams: (params || []).length,
      logMeta: {
        report_id: null,
        report_key: null,
        run_by: userId(req),
        params_json: { _source: "preview", ...paramValues },
      },
    });

    res.json({ status: "success", boundValues: values, ...result });
  } catch (e) {
    fail(res, "preview", e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// List / read
// ─────────────────────────────────────────────────────────────────────────────

router.get("/api/reports", jwtOrApiKey, async (req, res) => {
  try {
    const reports = await svc.listReports(req.db, {
      includeInactive: req.query.all === "1",
      kind: req.query.kind || null,
    });
    res.json({ status: "success", reports });
  } catch (e) {
    fail(res, "list", e);
  }
});

router.get("/api/reports/:id(\\d+)", jwtOrApiKey, async (req, res) => {
  try {
    const report = await svc.getReport(req.db, req.params.id);
    res.json({ status: "success", report });
  } catch (e) {
    fail(res, "get", e);
  }
});

router.get("/api/reports/:id(\\d+)/runs", jwtOrApiKey, async (req, res) => {
  try {
    const runs = await svc.listRuns(req.db, {
      reportId: req.params.id,
      limit: req.query.limit,
    });
    res.json({ status: "success", runs });
  } catch (e) {
    fail(res, "reportRuns", e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Version history
//
// A version is the PRE-CHANGE state, written by reportService immediately
// before every update and every delete. Reading history is open to any
// authorised caller (it is the same definition text they can already read);
// RESTORING is a write: requireUser here, and the lock is enforced inside
// restoreVersion → updateReport like every other write.
//
// History survives a delete, so /versions on a deleted id still returns rows.
// That is deliberate — the accidental delete is the case this table exists for.
// ─────────────────────────────────────────────────────────────────────────────

router.get("/api/reports/:id(\\d+)/versions", jwtOrApiKey, async (req, res) => {
  try {
    const versions = await svc.listVersions(req.db, Number(req.params.id), {
      limit: req.query.limit,
    });
    res.json({ status: "success", versions });
  } catch (e) {
    fail(res, "versions", e);
  }
});

router.get("/api/reports/:id(\\d+)/versions/:v(\\d+)", jwtOrApiKey, async (req, res) => {
  try {
    const version = await svc.getVersion(req.db, Number(req.params.id), Number(req.params.v));
    res.json({ status: "success", version });
  } catch (e) {
    fail(res, "version", e);
  }
});

router.post(
  "/api/reports/:id(\\d+)/versions/:v(\\d+)/restore",
  jwtOrApiKey,
  requireUser,
  async (req, res) => {
    try {
      const report = await svc.restoreVersion(
        req.db, Number(req.params.id), Number(req.params.v), actorOf(req)
      );
      res.json({ status: "success", report });
    } catch (e) {
      fail(res, "restore", e);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

router.post("/api/reports/:id(\\d+)/run", jwtOrApiKey, async (req, res) => {
  try {
    const params = (req.body && req.body.params) || {};
    const result = await svc.runReport(req.db, req.params.id, params, userId(req));
    res.json({ status: "success", ...result });
  } catch (e) {
    fail(res, "run", e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Authoring (any logged-in user; the lock is enforced in the service)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/api/reports", jwtOrApiKey, requireUser, async (req, res) => {
  try {
    const report = await svc.createReport(req.db, req.body || {}, actorOf(req));
    res.status(201).json({ status: "success", report });
  } catch (e) {
    fail(res, "create", e);
  }
});

router.put("/api/reports/:id(\\d+)", jwtOrApiKey, requireUser, async (req, res) => {
  try {
    const report = await svc.updateReport(req.db, req.params.id, req.body || {}, actorOf(req));
    res.json({ status: "success", report });
  } catch (e) {
    fail(res, "update", e);
  }
});

router.delete("/api/reports/:id(\\d+)", jwtOrApiKey, requireUser, async (req, res) => {
  try {
    const result = await svc.deleteReport(req.db, req.params.id, actorOf(req));
    res.json({ status: "success", ...result });
  } catch (e) {
    fail(res, "delete", e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reports/:id/lock — body { locked: boolean }
//
// Lock: any logged-in user (locking only adds protection). Unlock: owner or
// SU — the rules live in svc.setLock. Idempotent; returns the definition.
// ─────────────────────────────────────────────────────────────────────────────

router.post("/api/reports/:id(\\d+)/lock", jwtOrApiKey, requireUser, async (req, res) => {
  try {
    const { locked } = req.body || {};
    if (typeof locked !== "boolean") {
      throw Object.assign(new Error("body must be { locked: true|false }"), { status: 400 });
    }
    const report = await svc.setLock(req.db, Number(req.params.id), locked, actorOf(req));
    res.json({ status: "success", report });
  } catch (e) {
    fail(res, "lock", e);
  }
});

module.exports = router;