// services/reportAuthorService.js
//
// Slice 3: turns a plain-English question into a VALIDATED, DRY-RUN report
// definition. It never saves anything — the caller reviews and then POSTs to
// the normal SU-gated create path. Nothing this model produces reaches the
// database without a superuser explicitly saving it.
//
// ── THE LOOP ────────────────────────────────────────────────────────────────
//   1. Ask the model for a definition (JSON).
//   2. If it returned the refusal shape, hand that straight back — a refusal is
//      a legitimate, useful answer and must not be treated as a failure.
//   3. Validate the SQL against lib/reportSchema/manifest.js.
//   4. Dry-run it on the read-only pool using the model's own declared
//      defaults, so the user sees real rows before saving.
//   5. If (3) or (4) failed and an attempt remains, feed the ERROR back and
//      retry once. Validation and MySQL errors are both precise and
//      mechanical, which is exactly the kind of thing one repair turn fixes.
//
// ── WHAT THE MODEL IS ALLOWED TO SEE ────────────────────────────────────────
// The question, the curated schema, and — on a repair turn — its own previous
// SQL plus the error text and the row count.
//
// It NEVER sees result rows. case_notes, contact_notes, 341_notes and
// docs_missing are partly client-written through intake forms, so feeding rows
// to the component that writes SQL would open a prompt-injection path for no
// benefit whatsoever. Error strings come from MySQL or from our own validator;
// row counts are integers. Both are safe; rows are not.
//
// ── COST ────────────────────────────────────────────────────────────────────
// The embedded schema is ~4.5k input tokens, output ~600. That is roughly 2-3
// cents per attempt at sonnet rates, so a worst-case draft with one repair is
// about a nickel. Every attempt is stamped on ai_calls with
// consumer_ref='report_author', so cost and JSON-parse rate for this feature
// can be queried separately from court_extract.

const aiService = require("./aiService");
const reportService = require("./reportService");
const { validateSql, validateParams } = require("../lib/reportSchema/validator");

const MAX_ATTEMPTS = 2;          // initial + one repair
const AI_TIMEOUT_MS = 60000;     // 4.5k-token prompt with a long JSON body
const PREVIEW_ROW_LIMIT = 50;    // enough to judge shape; not a data dump

function err(status, message, detail) {
  const e = new Error(message);
  e.status = status;
  if (detail) e.detail = detail;
  return e;
}

const REPORT_KEY_RE = /^[a-z][a-z0-9_]{2,59}$/;
const ALLOWED_CATEGORIES = new Set([
  "Cases", "Contacts", "Appointments", "Activity", "Tasks", "Campaigns", "General",
]);

/**
 * Structural check on the model's JSON, before the SQL validator sees it.
 * Catches a malformed envelope with a clear message rather than letting a
 * missing field surface as a confusing SQL error three steps later.
 */
function shapeCheck(j) {
  if (!j || typeof j !== "object") return "response was not a JSON object";
  if (j.ok === false) return null;                    // refusal handled by caller
  if (j.ok !== true) return "response missing the 'ok' field";
  if (!REPORT_KEY_RE.test(String(j.report_key || ""))) {
    return "report_key must be lowercase letters, digits and underscores, 3-60 chars, starting with a letter";
  }
  if (!j.title || !String(j.title).trim()) return "title is missing";
  if (!j.sql || !String(j.sql).trim()) return "sql is missing";
  if (j.params != null && !Array.isArray(j.params)) return "params must be an array";
  if (j.caveats != null && !Array.isArray(j.caveats)) return "caveats must be an array";
  if (j.columns_meta != null && !Array.isArray(j.columns_meta)) return "columns_meta must be an array";
  const pv = validateParams(j.params || []);
  if (!pv.ok) return pv.error;
  return null;
}

/** Normalise the model's definition into the shape the create endpoint takes. */
function toDefinition(j) {
  return {
    report_key: String(j.report_key).trim(),
    title: String(j.title).trim(),
    category: ALLOWED_CATEGORIES.has(j.category) ? j.category : "General",
    description: j.description ? String(j.description).trim() : null,
    sql_text: String(j.sql).trim(),
    params: Array.isArray(j.params) ? j.params : [],
    columns_meta: Array.isArray(j.columns_meta) ? j.columns_meta : [],
    viz: j.viz && typeof j.viz === "object" ? j.viz : null,
    caveats: Array.isArray(j.caveats) ? j.caveats : [],
    source: "ai",
  };
}

/**
 * Build the user-message text for one attempt.
 * Everything here rides inside aiService's <untrusted_user_input> wrapper.
 */
function buildUserInput({ question, previous, previousError, previousRowCount }) {
  const parts = [`QUESTION: ${question}`];

  if (previous && previous.sql_text) {
    parts.push("");
    parts.push("PREVIOUS ATTEMPT (fix this):");
    parts.push(previous.sql_text);
    if (previousError) {
      parts.push("");
      parts.push(`ERROR: ${previousError}`);
    }
    if (previousRowCount != null) {
      parts.push(`ROWS RETURNED: ${previousRowCount}`);
    }
  }

  return parts.join("\n");
}

/**
 * Draft a report definition from a question.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.question            plain-English request
 * @param {object} [opts.previous]          prior definition, for a refine turn
 * @param {string} [opts.instruction]       refine instruction ("break it down by month")
 * @param {number|null} [opts.userId]
 * @returns {Promise<object>} see the route docs for the response shapes
 */
async function draft(db, { question, previous = null, instruction = null, userId = null } = {}) {
  const q = String(question || "").trim();
  if (!q) throw err(400, "A question is required");
  if (q.length > 2000) throw err(400, "Question is too long (2000 character limit)");

  // A refine turn is just a draft whose question carries the prior SQL and the
  // new instruction. Same prompt, same rules, no separate code path.
  let effectiveQuestion = q;
  if (previous && instruction) {
    effectiveQuestion = `${q}\n\nREFINE THIS EXISTING REPORT: ${instruction}`;
  }

  const attempts = [];
  let carry = { previous, previousError: null, previousRowCount: null };

  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const userInput = buildUserInput({
      question: effectiveQuestion,
      previous: carry.previous,
      previousError: carry.previousError,
      previousRowCount: carry.previousRowCount,
    });

    const ai = await aiService.call(db, {
      promptKey: "report_build",
      userInput,
      outputType: "json",
      timeout_ms: AI_TIMEOUT_MS,
      consumerRef: "report_author",
    });

    if (!ai.ok) {
      // Transport / auth / unparseable-JSON failure. Not worth a repair turn —
      // the repair loop exists for bad SQL, not a broken API call.
      throw err(
        502,
        "The report author could not be reached",
        `${ai.error}${ai.detail ? ": " + ai.detail : ""}`
      );
    }

    const j = ai.json;

    // ── Refusal: a first-class outcome, not an error ──────────────────────
    if (j && j.ok === false) {
      return {
        outcome: "refused",
        reason: j.reason || "The available data cannot answer this question.",
        suggestion: j.suggestion || null,
        attempts: n,
        callId: ai.callId,
      };
    }

    // ── Structural check ──────────────────────────────────────────────────
    const shapeErr = shapeCheck(j);
    if (shapeErr) {
      attempts.push({ n, stage: "shape", error: shapeErr });
      carry = {
        previous: j && j.sql ? { sql_text: String(j.sql) } : carry.previous,
        previousError: shapeErr,
        previousRowCount: null,
      };
      if (n === MAX_ATTEMPTS) {
        throw err(422, "The report author returned an unusable definition", shapeErr);
      }
      continue;
    }

    const definition = toDefinition(j);

    // ── SQL validation ────────────────────────────────────────────────────
    const v = validateSql(definition.sql_text, {
      expectedParams: definition.params.length,
    });
    if (!v.ok) {
      const msg = `${v.error}${v.detail ? " — " + v.detail : ""}`;
      attempts.push({ n, stage: "validate", error: msg });
      carry = { previous: definition, previousError: msg, previousRowCount: null };
      if (n === MAX_ATTEMPTS) {
        return {
          outcome: "invalid",
          definition,
          error: v.error,
          detail: v.detail || null,
          attempts: attempts,
          callId: ai.callId,
        };
      }
      continue;
    }

    // ── Dry run, using the model's own declared defaults ───────────────────
    let preview;
    try {
      const values = reportService.buildBindValues(definition.params, {});
      preview = await reportService.execute(db, {
        sql: definition.sql_text,
        values,
        rowLimit: PREVIEW_ROW_LIMIT,
        expectedParams: definition.params.length,
        logMeta: {
          report_id: null,
          report_key: definition.report_key,
          run_by: userId,
          params_json: { _source: "ai_draft", attempt: n },
        },
      });
      preview.boundValues = values;
    } catch (e) {
      const msg = e.message + (e.detail ? " — " + e.detail : "");
      attempts.push({ n, stage: "execute", error: msg });
      carry = { previous: definition, previousError: msg, previousRowCount: null };
      if (n === MAX_ATTEMPTS) {
        return {
          outcome: "invalid",
          definition,
          error: "The generated SQL did not run",
          detail: msg,
          attempts,
          callId: ai.callId,
        };
      }
      continue;
    }

    // ── Success ───────────────────────────────────────────────────────────
    return {
      outcome: "drafted",
      definition,
      preview: {
        rows: preview.rows,
        fields: preview.fields,
        rowCount: preview.rowCount,
        truncated: preview.truncated,
        durationMs: preview.durationMs,
        boundValues: preview.boundValues,
      },
      attempts: n,
      repairs: attempts,
      usage: ai.usage,
      callId: ai.callId,
    };
  }

  // Unreachable: every path inside the loop returns or throws on the last pass.
  throw err(500, "Report author loop exited unexpectedly");
}

module.exports = { draft, MAX_ATTEMPTS, PREVIEW_ROW_LIMIT };