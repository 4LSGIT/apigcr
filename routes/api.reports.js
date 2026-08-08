// routes/api.reports.js
//
/**
 * routes/api.reports.js — REST routes for the reports engine (Slice 1).
 *
 * GET    /api/reports                 — list active reports (?all=1 inactive too, ?kind=view|report to filter)
 * GET    /api/reports/schema          — curated manifest summary (what reports can see)
 * GET    /api/reports/runs            — recent run history across all reports
 * POST   /api/reports/draft           — SU: plain-English question → validated draft definition
 * POST   /api/reports/preview         — SU: validate + run an unsaved definition, never persisted
 * GET    /api/reports/:id             — full definition incl. sql_text
 * POST   /api/reports/:id/run         — run it; body { params: {...} }
 * GET    /api/reports/:id/runs        — run history for one report
 * POST   /api/reports                 — create
 * PUT    /api/reports/:id             — update (report_key immutable)
 * DELETE /api/reports/:id             — delete
 *
 * Auto-mounted from routes/ (server.js readdir loop).
 *
 * ── AUTH ────────────────────────────────────────────────────────────────────
 * All routes require JWT or API key. Read + run are open to any authorised
 * user; CREATE / UPDATE / DELETE additionally require SU, because a report
 * definition is stored SQL and authoring it is a materially different act from
 * running one somebody already reviewed. Slice 3's AI author writes through
 * the same SU-gated create path, so nothing the model produces reaches the
 * database without a superuser saving it.
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

function fail(res, tag, e) {
  const status = e.status || 500;
  if (status >= 500) console.error(`[api.reports] ${tag} error:`, e);
  const body = { status: "error", message: e.message };
  if (e.detail) body.detail = e.detail;
  res.status(status).json(body);
}

const userId = (req) => (req.auth && req.auth.userId != null ? req.auth.userId : null);

/**
 * Authoring requires SU. We check user_auth on the JWT the same way
 * lib/auth.superuser does, rather than importing it — that module is bound to
 * the dbConsole audit tooling and pulling it in here would drag rate-limit
 * state we don't want shared.
 *
 * Gates: create, update, delete, draft, preview. Everything that authors or
 * executes SQL that has not already been reviewed and saved.
 */
function requireSU(req, res, next) {
  if (req.auth && req.auth.type === "jwt" && req.auth.user_auth === "authorized - SU") {
    return next();
  }
  return res.status(403).json({
    status: "error",
    message: "Writing or previewing a report definition requires superuser access.",
    detail: "Any authorised user can run reports that have already been saved.",
  });
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
// POST /api/reports/draft — AI author (SU only)
//
// Body: { question, previous?, instruction? }
//   question    plain-English request
//   previous    a prior definition, when refining
//   instruction what to change about it
//
// Returns one of three outcomes, all HTTP 200 — none of these is a server
// error, and the UI renders each differently:
//   { outcome:'drafted',  definition, preview, attempts, repairs, usage }
//   { outcome:'refused',  reason, suggestion }   ← data can't answer it
//   { outcome:'invalid',  definition, error, detail, attempts }
//
// Nothing is persisted. The user reviews the draft and POSTs it to
// /api/reports to save, which re-validates on the way in.
// ─────────────────────────────────────────────────────────────────────────────

router.post("/api/reports/draft", jwtOrApiKey, requireSU, async (req, res) => {
  try {
    const { question, previous, instruction } = req.body || {};
    const result = await authorSvc.draft(req.db, {
      question, previous, instruction, userId: userId(req),
    });
    res.json({ status: "success", ...result });
  } catch (e) {
    fail(res, "draft", e);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reports/preview — run an UNSAVED definition (SU only)
//
// Body: { sql_text, params?, paramValues?, row_limit? }
//
// Validated by exactly the same validator as a saved report, executed on the
// same SELECT-only pool, and logged to report_runs with report_id NULL.
// Nothing is written to report_definitions.
//
// SECURITY NOTE: this accepts SQL from the caller, which looks like a widened
// surface but is not. It is SU-only, and an SU already has /admin/db/query with
// allowWrite — this endpoint grants strictly LESS than what that user can
// already do, while adding the manifest allowlist, the column denylist and the
// EXPLAIN gate on top. It exists so a draft can be seen before it is saved.
// ─────────────────────────────────────────────────────────────────────────────

router.post("/api/reports/preview", jwtOrApiKey, requireSU, async (req, res) => {
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
// Authoring (SU only)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/api/reports", jwtOrApiKey, requireSU, async (req, res) => {
  try {
    const report = await svc.createReport(req.db, req.body || {}, userId(req));
    res.status(201).json({ status: "success", report });
  } catch (e) {
    fail(res, "create", e);
  }
});

router.put("/api/reports/:id(\\d+)", jwtOrApiKey, requireSU, async (req, res) => {
  try {
    const report = await svc.updateReport(req.db, req.params.id, req.body || {}, userId(req));
    res.json({ status: "success", report });
  } catch (e) {
    fail(res, "update", e);
  }
});

router.delete("/api/reports/:id(\\d+)", jwtOrApiKey, requireSU, async (req, res) => {
  try {
    const result = await svc.deleteReport(req.db, req.params.id);
    res.json({ status: "success", ...result });
  } catch (e) {
    fail(res, "delete", e);
  }
});

module.exports = router;