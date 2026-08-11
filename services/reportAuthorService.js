// services/reportAuthorService.js
//
// Turns a plain-English question into a VALIDATED, DRY-RUN report or view
// definition. It never saves anything — the caller reviews and then POSTs or
// PUTs through the normal SU-gated paths. Nothing this model produces reaches
// the database without a superuser explicitly saving it.
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
// ── REFINE IS NOT REPAIR ────────────────────────────────────────────────────
// Two different things used to share one code path, and the framing was wrong
// for both. A REPAIR turn says "this SQL failed, here is the error, fix it" and
// the prompt tells the model not to restate the same SQL. A REFINE turn says
// "this definition WORKS, change one thing about it" and the model must keep
// everything it wasn't asked to touch. Sending a refine down the repair path
// meant the model saw working SQL labelled "fix this" with no error, and was
// told not to repeat it — the opposite of the instruction it needed.
//
// They are now distinct blocks in buildUserInput() and distinct sections in the
// prompt, and a refine carries the WHOLE base definition (params, columns_meta,
// viz, caveats), not just sql_text. The model cannot preserve what it cannot
// see, and views carry most of their value outside the SQL: the action wiring
// that makes a row clickable and the select controls that make a param usable
// both live in columns_meta / params.
//
// ── IDENTITY IS PINNED, NOT SUGGESTED ───────────────────────────────────────
// report_key is immutable server-side (reportService.updateReport rejects a
// change), and the model regenerates a key on every turn. On a refine we
// therefore OVERWRITE the model's key with the base's, rather than hoping it
// echoed it back. Same defensive posture for visibility, and base-fallbacks for
// kind / category / row_limit so a refine can't silently demote a view to a
// report or move it out of its nav group.
//
// ── WHAT THE MODEL IS ALLOWED TO SEE ────────────────────────────────────────
// The question, the curated schema, the base definition on a refine, and — on a
// repair turn — its own previous SQL plus the error text and the row count.
//
// It NEVER sees result rows. case_notes, contact_notes, 341_notes and
// docs_missing are partly client-written through intake forms, so feeding rows
// to the component that writes SQL would open a prompt-injection path for no
// benefit whatsoever. Error strings come from MySQL or from our own validator;
// row counts are integers. Both are safe; rows are not.
//
// ── COST ────────────────────────────────────────────────────────────────────
// The embedded schema is ~4.5k input tokens, output ~600. A refine adds the
// base definition, typically another ~400. Every attempt is stamped on ai_calls
// with consumer_ref='report_author'.

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

// "Views" is in this set because all three hand-authored views live in it and
// it is the nav grouping customView.html browses by. Leaving it out meant every
// AI refine of a view silently relabelled it "General" and dropped it out of
// the group — a data-loss bug disguised as a default.
const ALLOWED_CATEGORIES = new Set([
  "Cases", "Contacts", "Appointments", "Activity", "Tasks", "Campaigns",
  "Views", "General",
]);

const ALLOWED_KINDS = new Set(["report", "view"]);

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
  if (j.kind != null && !ALLOWED_KINDS.has(String(j.kind))) {
    return `kind must be "report" or "view" (got "${j.kind}")`;
  }
  const pv = validateParams(j.params || []);
  if (!pv.ok) return pv.error;
  return null;
}

/**
 * Normalise the model's definition into the shape the create/update endpoints
 * take, merged over a base definition when refining.
 *
 * The merge is deliberately asymmetric. Content the user asked about (title,
 * description, sql, params, caveats) comes from the model. Identity and
 * placement come from the base, and where a field is BOTH high-value and
 * silently-lost, the base wins whenever the model left it blank.
 *
 * Every rule below exists because the prompt alone is not a guarantee. The
 * prompt tells the model to preserve these things; this function makes it so
 * even when the model doesn't. Prompts are best-effort, invariants are not.
 *
 *   report_key   PINNED to base. Immutable server-side, and the model re-derives
 *                a key from the title every single turn — "add a year filter"
 *                came back as `filing_fees_by_year` in testing.
 *   visibility   PINNED to base. Not part of the model's output contract.
 *   kind         Model-first. "Turn this report into a clickable view" is a
 *                legitimate refine, so this one genuinely must be changeable.
 *   category     PINNED to base WHEN KIND IS UNCHANGED. Otherwise the model's
 *                subject-area instinct ("Cases") drags views out of the "Views"
 *                nav group that customView.html browses by — a valid-looking
 *                value that quietly hides the view. Re-picked only when the
 *                kind conversion makes the old grouping wrong. Recategorising
 *                without converting is a one-field manual edit.
 *   columns_meta Base wins when the model returns NOTHING and the base had
 *                something. This is the action wiring — open_case, open_contact,
 *                the hidden id columns. Losing it turns a work list into a dead
 *                table, and nobody notices until they try to click a row.
 *   viz          Same rule. On a refine, a null viz almost always means the
 *                model forgot, not "please discard the combo chart".
 *
 * @param {object} j          the model's JSON
 * @param {object|null} base  the definition being refined, if any
 */
function toDefinition(j, base = null) {
  const kind = ALLOWED_KINDS.has(String(j.kind))
    ? String(j.kind)
    : (base && base.kind) || "report";

  const kindUnchanged = !!base && kind === ((base.kind) || "report");

  let category;
  if (base && kindUnchanged) {
    category = base.category || (kind === "view" ? "Views" : "General");
  } else if (ALLOWED_CATEGORIES.has(j.category)) {
    category = j.category;
  } else {
    category = kind === "view" ? "Views" : "General";
  }

  const modelMeta = Array.isArray(j.columns_meta) ? j.columns_meta : [];
  const baseMeta = (base && Array.isArray(base.columns_meta)) ? base.columns_meta : [];
  const columns_meta = modelMeta.length ? modelMeta : baseMeta;

  const modelViz = j.viz && typeof j.viz === "object" ? j.viz : null;
  const viz = modelViz || (base ? (base.viz || null) : null);

  const def = {
    report_key: base ? base.report_key : String(j.report_key).trim(),
    title: String(j.title).trim(),
    category,
    kind,
    visibility: (base && base.visibility) || "shared",
    description: j.description ? String(j.description).trim() : null,
    sql_text: String(j.sql).trim(),
    params: Array.isArray(j.params) ? j.params : [],
    columns_meta,
    viz,
    caveats: Array.isArray(j.caveats) ? j.caveats : [],
    source: "ai",
  };

  const rl = Number(j.row_limit);
  if (Number.isFinite(rl) && rl > 0) def.row_limit = Math.round(rl);
  else if (base && base.row_limit) def.row_limit = base.row_limit;

  // Tells the UI whether Save means POST or PUT. Harmless if it leaks through
  // to either endpoint — both destructure known fields and ignore the rest —
  // but the UI strips it anyway.
  if (base && base.id != null) def._base_id = base.id;

  return def;
}

/**
 * The subset of a definition the model needs in order to preserve it.
 *
 * Deliberately excludes id / created_by / updated_at — provenance the model has
 * no use for and could only get wrong. report_key is included as read-only
 * context so the model doesn't invent a rename it would then be told to undo.
 */
function baseForPrompt(base) {
  return {
    report_key: base.report_key,
    title: base.title,
    category: base.category,
    kind: base.kind || "report",
    description: base.description || null,
    sql: base.sql_text,
    params: base.params || [],
    columns_meta: base.columns_meta || [],
    viz: base.viz || null,
    caveats: base.caveats || [],
    row_limit: base.row_limit || null,
  };
}

/**
 * Build the user-message text for one attempt.
 * Everything here rides inside aiService's <untrusted_user_input> wrapper.
 *
 * Three blocks, at most two of which appear at once:
 *   QUESTION            — always
 *   CURRENT DEFINITION  — refine: this works, change one thing about it
 *   PREVIOUS ATTEMPT    — repair: this failed, here is the error
 */
function buildUserInput({ question, base, instruction, previous, previousError, previousRowCount }) {
  const parts = [];

  if (base && instruction) {
    parts.push(`CHANGE REQUESTED: ${instruction}`);
    parts.push("");
    parts.push("CURRENT DEFINITION (refine this — keep everything you were not asked to change):");
    parts.push(JSON.stringify(baseForPrompt(base), null, 2));
  } else {
    parts.push(`QUESTION: ${question}`);
    if (base) {
      parts.push("");
      parts.push("CURRENT DEFINITION (refine this — keep everything you were not asked to change):");
      parts.push(JSON.stringify(baseForPrompt(base), null, 2));
    }
  }

  if (previous && previous.sql_text) {
    parts.push("");
    parts.push("PREVIOUS ATTEMPT (this one failed — fix this specific error):");
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
 * Draft a report or view definition.
 *
 * Three calling shapes:
 *   { question }                        new definition from scratch
 *   { base, instruction }               refine an existing one
 *   { question, base, instruction }     same; question is ignored when an
 *                                       instruction is present
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} [opts.question]       plain-English request
 * @param {object} [opts.base]           the definition being refined (saved or
 *                                       in-flight draft), full shape
 * @param {string} [opts.instruction]    what to change ("add a year filter")
 * @param {number|null} [opts.userId]
 * @returns {Promise<object>} see the route docs for the response shapes
 */
async function draft(db, { question, base = null, instruction = null, userId = null } = {}) {
  const q = String(question || "").trim();
  const instr = String(instruction || "").trim();

  if (!q && !(base && instr)) {
    throw err(400, "A question is required (or a definition to refine plus an instruction)");
  }
  if (q.length > 2000) throw err(400, "Question is too long (2000 character limit)");
  if (instr.length > 2000) throw err(400, "Instruction is too long (2000 character limit)");

  const attempts = [];
  let carry = { previous: null, previousError: null, previousRowCount: null };

  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const userInput = buildUserInput({
      question: q,
      base,
      instruction: instr || null,
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
        baseId: base && base.id != null ? base.id : null,
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

    const definition = toDefinition(j, base);

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
          baseId: base && base.id != null ? base.id : null,
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
          report_id: base && base.id != null ? base.id : null,
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
          baseId: base && base.id != null ? base.id : null,
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
      // The UI diffs against this and decides POST vs PUT from baseId.
      base: base
        ? {
            id: base.id != null ? base.id : null,
            report_key: base.report_key,
            title: base.title,
            kind: base.kind || "report",
            category: base.category,
            sql_text: base.sql_text,
            params: base.params || [],
            columns_meta: base.columns_meta || [],
            viz: base.viz || null,
            caveats: base.caveats || [],
            row_limit: base.row_limit || null,
          }
        : null,
      baseId: base && base.id != null ? base.id : null,
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

module.exports = {
  draft,
  MAX_ATTEMPTS,
  PREVIEW_ROW_LIMIT,
  ALLOWED_CATEGORIES,
  ALLOWED_KINDS,
};