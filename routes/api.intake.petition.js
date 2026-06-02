// routes/api.intake.petition.js
//
/**
 * Petition Intake Route (MIEB Voluntary Petition → case stamping)
 * ---------------------------------------------------------------
 * POST /api/intake/petition
 *
 * Consumes the data from a MIEB "Voluntary Petition" court email and either
 * STAMPS the docket onto the client's waiting (pre-filing) case or creates a
 * new filed case. This is the dedicated entry point for the filing event;
 * it deliberately does NOT reuse /api/intake/case, because that route's
 * "docket supplied ⇒ always insert" rule would skip the waiting Open case
 * and spawn a duplicate. The Calendly intake flow (find-or-reuse) keeps using
 * /api/intake/contact + /api/intake/case unchanged.
 *
 * WHY A SEPARATE ROUTE
 *   - The petition email is the moment of filing. The correct target is the
 *     existing 'Open'/'Pending' (pre-filing) case, which carries NO docket yet
 *     (verified in prod: 590 Open bankruptcy cases, 0 dockets). We stamp it
 *     and advance it to 'Filed'.
 *   - A 'Filed'/'Closed' case is a completed filing. A NEW petition for that
 *     same client is a NEW matter, so 'Filed'/'Closed' are excluded from the
 *     match set — a second filing opens a fresh case rather than reusing the
 *     old one.
 *
 * INPUT (JSON body)
 *   case_name    string  REQUIRED  the "Case Name:" cell. Single ("India Gragg")
 *                                  or joint ("John Smith and Jane Doe" / "...& ...").
 *                                  First-named debtor is the PRIMARY (filing
 *                                  convention), used first for matching.
 *   case_number  string  REQUIRED* short docket, e.g. "26-31193". The real case
 *                                  number. (case_number_full derived later from
 *                                  a subsequent email; stored NULL here.)
 *   chapter      string  REQUIRED* "7" | "11" | "13" (from subject "Ch N").
 *   file_date    string  optional  "YYYY-MM-DD" filing date. Defaults to today ET.
 *   subject      string  optional  raw email subject. If case_number and/or
 *                                  chapter are absent, they are parsed from this
 *                                  (`^(\d{2}-\d{5}) ... Ch (\d+)`). Lets the
 *                                  caller forward the subject and nothing else.
 *
 *   * case_number and chapter are required EITHER directly OR via `subject`.
 *
 * DECISION TREE
 *   1. Parse case_name → primary (+ optional joint). Each via parseName.
 *   2. Resolve contact by name LIKE %first%lnameOnly% (primary, then joint):
 *        0 matches  → CREATE contact from primary, alert human, continue.
 *        1 match    → use it.
 *        2+ matches → 409 + alert (don't guess which client a filing belongs to).
 *   3. Docket collision (case_number against case_number + case_number_full):
 *        on THIS contact's case      → idempotent: return it, no-op.
 *        on a DIFFERENT contact's case → 409 + alert (docket↔wrong client).
 *        nowhere                     → continue.
 *   4. Find waiting case (stage IN Open/Pending, Bankruptcy type, newest):
 *        found    → UPDATE: case_number, case_type=Bankruptcy - Ch. N,
 *                   case_chapter, case_stage='Filed', case_file_date.
 *        not found→ INSERT new case @ 'Filed' + case_relate.
 *   5. Log the action.
 *
 * RESPONSES
 *   200 — { action: "stamped" | "created" | "already_filed", id, case_id, ... }
 *   400 — bad/missing input
 *   409 — ambiguous contact, or docket collision on a different client
 *   500 — unexpected
 *
 * NOTE: case_type stored as "Bankruptcy - Ch. 7" / "Bankruptcy - Ch. 13"
 *       (period + space), matching the existing production format. Pre-filing
 *       cases are plain "Bankruptcy"; filing refines the type.
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const { parseName } = require("../lib/parseName");
const contactService = require("../services/contactService");

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

/**
 * Generate an 8-char alphanumeric case ID (crypto), excluding base64url's
 * '-' and '_' for URL/copy-paste cleanliness. Lifted from api.intake.js so
 * the two creation paths produce identically-shaped IDs.
 */
function generateCaseId() {
  let id;
  do {
    id = crypto.randomBytes(6).toString("base64url").slice(0, 8);
  } while (id.includes("-") || id.includes("_"));
  return id;
}

/**
 * Split a "Case Name:" value into [primary, joint?] raw name strings.
 * Joint petitions are "X and Y" or "X & Y". The first-named debtor is the
 * PRIMARY by filing convention. Returns 1 or 2 trimmed strings.
 */
function splitDebtors(caseName) {
  return String(caseName)
    .split(/\s+(?:and|&)\s+/i)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Parse short docket + chapter out of a MIEB subject line, e.g.
 *   25-50808 "Voluntary Petition (Chapter 7)" Ch 7
 * Returns { caseNumber, chapter } with nulls for anything not found.
 */
function parseSubject(subject) {
  const out = { caseNumber: null, chapter: null };
  if (!subject || typeof subject !== "string") return out;
  const num = subject.match(/\b(\d{2}-\d{5})\b/);
  if (num) out.caseNumber = num[1];
  // Prefer the trailing "Ch N"; fall back to "(Chapter N)".
  const ch = subject.match(/\bCh\.?\s*(\d{1,2})\b/i)
          || subject.match(/Chapter\s+(\d{1,2})/i);
  if (ch) out.chapter = ch[1];
  return out;
}

/** Normalize chapter to a bare digit string ("7"/"11"/"13"). */
function normalizeChapter(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/(\d{1,2})/);
  return m ? m[1] : null;
}

/**
 * Look up contacts whose name matches a parsed debtor, using the firm's
 * established pattern: contact_name LIKE %first%lnameOnly%. Returns rows
 * [{ contact_id, contact_name }]. Empty array on no usable name parts.
 */
async function findContactsByName(db, parsed) {
  const first = (parsed.firstName || "").trim();
  const last = (parsed.lnameOnly || "").trim();
  if (!first || !last) return [];
  const [rows] = await db.query(
    `SELECT contact_id, contact_name
       FROM contacts
      WHERE contact_name LIKE CONCAT('%', ?, '%', ?, '%')`,
    [first, last]
  );
  return rows;
}

// ─────────────────────────────────────────
// POST /api/intake/petition
// ─────────────────────────────────────────
router.post("/api/intake/petition", jwtOrApiKey, async (req, res) => {
  // ── Gather + reconcile input (direct fields win; subject fills gaps) ──
  const caseName = (typeof req.body.case_name === "string") ? req.body.case_name.trim() : "";
  const fromSubject = parseSubject(req.body.subject);

  let caseNumber = (typeof req.body.case_number === "string") ? req.body.case_number.trim() : "";
  if (!caseNumber && fromSubject.caseNumber) caseNumber = fromSubject.caseNumber;

  let chapter = normalizeChapter(req.body.chapter) || normalizeChapter(fromSubject.chapter);

  // file_date: validate YYYY-MM-DD; else default to today ET at insert time.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  let fileDate = req.body.file_date;
  fileDate = (typeof fileDate === "string" && fileDate.trim() !== "") ? fileDate.trim() : null;
  if (fileDate !== null && !DATE_RE.test(fileDate)) {
    return res.status(400).json({ status: "error", message: "file_date must be YYYY-MM-DD" });
  }

  // ── Required fields ──
  if (!caseName) {
    return res.status(400).json({ status: "error", message: "case_name is required" });
  }
  if (!caseNumber) {
    return res.status(400).json({ status: "error", message: "case_number is required (or supply a parseable subject)" });
  }
  if (caseNumber.length > 20) {
    return res.status(400).json({ status: "error", message: "case_number exceeds 20 chars" });
  }
  if (!chapter) {
    return res.status(400).json({ status: "error", message: "chapter is required (or supply a parseable subject)" });
  }

  // "Bankruptcy - Ch. 13" (period + space) — matches production format. <=20 chars.
  const caseTypeFull = `Bankruptcy - Ch. ${chapter}`;

  // SQL fragment + params for "filed date": supplied value, or today ET.
  const fileDateSql = fileDate ? "?" : "CONVERT_TZ(NOW(), 'UTC', 'America/New_York')";
  const fileDateParam = fileDate ? [fileDate] : [];

  try {
    // ─────────────────────────────────────
    // STEP 1+2 — Resolve the client contact
    // ─────────────────────────────────────
    const debtors = splitDebtors(caseName);            // [primary, joint?]
    const primaryParsed = parseName(debtors[0] || "");
    const jointParsed = debtors[1] ? parseName(debtors[1]) : null;

    let contactId = null;
    let matchedVia = null;   // 'primary' | 'joint' | 'created'

    // Try primary first, then joint (spouse may have booked the intake appt).
    let matches = await findContactsByName(req.db, primaryParsed);
    if (matches.length === 0 && jointParsed) {
      const jm = await findContactsByName(req.db, jointParsed);
      if (jm.length) { matches = jm; matchedVia = "joint"; }
    } else if (matches.length) {
      matchedVia = "primary";
    }

    if (matches.length >= 2) {
      // Ambiguous — refuse to guess which client a filing belongs to.
      // TODO(alert): route to the firm's review/alert channel.
      console.log(
        `[petition] AMBIGUOUS contact for "${caseName}" (docket ${caseNumber}): ` +
        `${matches.length} matches [${matches.map(m => m.contact_id).join(", ")}] — needs human review`
      );
      return res.status(409).json({
        status: "error",
        message: `multiple contacts match "${caseName}" — needs human review`,
        candidates: matches.map(m => ({ contact_id: m.contact_id, contact_name: m.contact_name })),
        docket: caseNumber,
      });
    }

    if (matches.length === 1) {
      contactId = matches[0].contact_id;
    } else {
      // ── 0 matches → CREATE contact from the PRIMARY debtor, alert human ──
      // TODO(alert): a court filing arrived for a client we had no record of.
      console.log(
        `[petition] NO contact match for "${caseName}" (docket ${caseNumber}) — ` +
        `creating new contact from primary debtor; needs human review`
      );
      const created = await contactService.createContact(req.db, {
        fname: primaryParsed.firstName,
        mname: primaryParsed.middleName,
        lname: primaryParsed.lastName,   // full last incl. suffix, mirrors intake CREATE
        phone: "",
        email: "",
        type: "Client",
      });
      contactId = created.contact_id;
      matchedVia = "created";
    }

    // ─────────────────────────────────────
    // STEP 3 — Docket collision check
    // ─────────────────────────────────────
    // Does this short docket already live on a case (either docket column)?
    const [clash] = await req.db.query(
      `SELECT c.case_id, cr.case_relate_client_id AS client_id
         FROM cases c
         LEFT JOIN case_relate cr
                ON cr.case_relate_case_id = c.case_id
               AND cr.case_relate_type = 'Primary'
        WHERE (c.case_number      IS NOT NULL AND c.case_number      <> '' AND c.case_number      = ?)
           OR (c.case_number_full IS NOT NULL AND c.case_number_full <> '' AND c.case_number_full = ?)
        LIMIT 1`,
      [caseNumber, caseNumber]
    );

    if (clash.length) {
      const c = clash[0];
      if (c.client_id != null && c.client_id === contactId) {
        // Same client already carries this docket → idempotent (retry/re-fire).
        return res.json({
          status: "success",
          message: `case ${c.case_id} already filed under docket ${caseNumber}`,
          action: "already_filed",
          id: c.case_id,
          case_id: c.case_id,
          contact_id: contactId,
          docket: caseNumber,
        });
      }
      // Docket on a DIFFERENT client → data-quality alarm, not a routine create.
      // TODO(alert): docket assigned to the wrong client, or duplicate docket.
      console.log(
        `[petition] DOCKET COLLISION: ${caseNumber} already on case ${c.case_id} ` +
        `(client ${c.client_id}) but petition resolved to client ${contactId} — needs human review`
      );
      return res.status(409).json({
        status: "error",
        message: `docket ${caseNumber} already in use by case ${c.case_id} for a different client — needs human review`,
        conflict: { case_id: c.case_id, client_id: c.client_id },
        resolved_contact_id: contactId,
      });
    }

    // ─────────────────────────────────────
    // STEP 4 — Find the waiting (pre-filing) case
    // ─────────────────────────────────────
    // Pre-filing posture only: Open/Pending. Filed/Closed are completed matters
    // — a new petition for such a client opens a fresh case instead.
    const [existing] = await req.db.query(
      `SELECT c.case_id, c.case_type
         FROM cases c
         LEFT JOIN case_relate cr ON c.case_id = cr.case_relate_case_id
        WHERE cr.case_relate_client_id = ?
          AND cr.case_relate_type = 'Primary'
          AND c.case_stage IN ('Open', 'Pending')
          AND (c.case_type = 'Bankruptcy' OR c.case_type LIKE 'Bankruptcy - Ch%')
        ORDER BY c.case_open_date DESC
        LIMIT 1`,
      [contactId]
    );

    if (existing.length) {
      // ── STAMP the waiting case ──
      const caseId = existing[0].case_id;
      await req.db.query(
        `UPDATE cases
            SET case_number  = ?,
                case_type    = ?,
                case_chapter = ?,
                case_stage   = 'Filed',
                case_file_date = ${fileDateSql}
          WHERE case_id = ?`,
        [caseNumber, caseTypeFull, chapter, ...fileDateParam, caseId]
      );

      await req.db.query(
        `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
         VALUES ('update', CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), ?, 0, ?)`,
        [
          caseId,
          JSON.stringify({
            action: "petition_stamped",
            case_number: caseNumber,
            case_type: caseTypeFull,
            chapter,
            contact_id: contactId,
            matched_via: matchedVia,
          }),
        ]
      );

      return res.json({
        status: "success",
        message: `docket ${caseNumber} stamped onto case ${caseId}; stage → Filed`,
        action: "stamped",
        id: caseId,
        case_id: caseId,
        contact_id: contactId,
        case_type: caseTypeFull,
        chapter,
        matched_via: matchedVia,
      });
    }

    // ─────────────────────────────────────
    // STEP 4b — No waiting case → CREATE a new Filed case
    // ─────────────────────────────────────
    let caseId;
    let inserted = false;
    let attempts = 0;
    while (!inserted && attempts < 10) {
      caseId = generateCaseId();
      attempts++;
      try {
        await req.db.query(
          `INSERT INTO cases
             (case_id, case_open_date, case_file_date, case_type, case_chapter, case_stage, case_number)
           VALUES
             (?, CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), ${fileDateSql}, ?, ?, 'Filed', ?)`,
          [caseId, ...fileDateParam, caseTypeFull, chapter, caseNumber]
        );
        inserted = true;
      } catch (err) {
        if (err.code !== "ER_DUP_ENTRY") throw err;
        // case_id collision — retry with a new id.
      }
    }
    if (!inserted) {
      throw new Error("Failed to generate unique case ID after 10 attempts");
    }

    const [relateResult] = await req.db.query(
      `INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type)
       VALUES (?, ?, 'Primary')`,
      [caseId, contactId]
    );

    await req.db.query(
      `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
       VALUES ('update', CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), ?, 0, ?)`,
      [
        caseId,
        JSON.stringify({
          action: "petition_case_created",
          case_number: caseNumber,
          case_type: caseTypeFull,
          chapter,
          contact_id: contactId,
          matched_via: matchedVia,
        }),
      ]
    );

    return res.json({
      status: "success",
      message: `no waiting case found; created filed case ${caseId} under docket ${caseNumber}`,
      action: "created",
      id: caseId,
      case_id: caseId,
      contact_id: contactId,
      case_relate: relateResult.insertId,
      case_type: caseTypeFull,
      chapter,
      matched_via: matchedVia,
    });

  } catch (err) {
    console.error("POST /api/intake/petition error:", err);
    res.status(500).json({ status: "error", message: "Failed to process petition" });
  }
});

module.exports = router;