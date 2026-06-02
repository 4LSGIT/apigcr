// routes/api.intake.petitionTest.js
//
/**
 * Petition Intake Route — DRY RUN (read-only mirror of api.intake.petition.js)
 * ---------------------------------------------------------------------------
 * POST /api/intake/petitionTest
 *
 * Identical resolution logic to /api/intake/petition, but performs NO writes.
 * It runs every lookup (contact name match, docket collision, waiting-case
 * search) and returns the SAME response shape it would have produced, PLUS a
 * `dry_run: true` flag and a `plan` block describing exactly what the live
 * route would do — including the SQL it would have executed.
 *
 * Use this to validate parsing + matching against real emails before letting
 * the live route mutate cases. No contact is created, no case stamped, no case
 * inserted, no log written.
 *
 * Input contract is identical to the live route:
 *   { case_name, case_number, chapter, file_date?, subject? }
 *
 * Response adds:
 *   dry_run : true
 *   plan    : {
 *     action,            // what the live route would do
 *     would_create_contact?, contact_payload?,
 *     would_write_sql?,  // array of { sql, params } it would have run
 *     notes[]            // human-readable summary of the decision path
 *   }
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const { parseName } = require("../lib/parseName");

// ─────────────────────────────────────────
// HELPERS (identical to live route, minus generateCaseId which is write-only)
// ─────────────────────────────────────────

function splitDebtors(caseName) {
  return String(caseName)
    .split(/\s+(?:and|&)\s+/i)
    .map(s => s.trim())
    .filter(Boolean);
}

function parseSubject(subject) {
  const out = { caseNumber: null, chapter: null };
  if (!subject || typeof subject !== "string") return out;
  const num = subject.match(/\b(\d{2}-\d{5})\b/);
  if (num) out.caseNumber = num[1];
  const ch = subject.match(/\bCh\.?\s*(\d{1,2})\b/i)
          || subject.match(/Chapter\s+(\d{1,2})/i);
  if (ch) out.chapter = ch[1];
  return out;
}

function normalizeChapter(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/(\d{1,2})/);
  return m ? m[1] : null;
}

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
// POST /api/intake/petitionTest
// ─────────────────────────────────────────
router.post("/api/intake/petitionTest", jwtOrApiKey, async (req, res) => {
  const notes = [];

  // ── Gather + reconcile input (direct fields win; subject fills gaps) ──
  const caseName = (typeof req.body.case_name === "string") ? req.body.case_name.trim() : "";
  const fromSubject = parseSubject(req.body.subject);

  let caseNumber = (typeof req.body.case_number === "string") ? req.body.case_number.trim() : "";
  if (!caseNumber && fromSubject.caseNumber) {
    caseNumber = fromSubject.caseNumber;
    notes.push(`case_number absent in body; parsed "${caseNumber}" from subject`);
  }

  const chapterDirect = normalizeChapter(req.body.chapter);
  let chapter = chapterDirect || normalizeChapter(fromSubject.chapter);
  if (!chapterDirect && chapter) {
    notes.push(`chapter absent in body; parsed "${chapter}" from subject`);
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  let fileDate = req.body.file_date;
  fileDate = (typeof fileDate === "string" && fileDate.trim() !== "") ? fileDate.trim() : null;
  if (fileDate !== null && !DATE_RE.test(fileDate)) {
    return res.status(400).json({ status: "error", dry_run: true, message: "file_date must be YYYY-MM-DD" });
  }

  if (!caseName) {
    return res.status(400).json({ status: "error", dry_run: true, message: "case_name is required" });
  }
  if (!caseNumber) {
    return res.status(400).json({ status: "error", dry_run: true, message: "case_number is required (or supply a parseable subject)" });
  }
  if (caseNumber.length > 20) {
    return res.status(400).json({ status: "error", dry_run: true, message: "case_number exceeds 20 chars" });
  }
  if (!chapter) {
    return res.status(400).json({ status: "error", dry_run: true, message: "chapter is required (or supply a parseable subject)" });
  }

  const caseTypeFull = `Bankruptcy - Ch. ${chapter}`;
  const fileDateDisplay = fileDate ? fileDate : "CONVERT_TZ(NOW(),'UTC','America/New_York') [today ET]";

  try {
    // ─────────────────────────────────────
    // STEP 1+2 — Resolve the client contact (READ ONLY)
    // ─────────────────────────────────────
    const debtors = splitDebtors(caseName);
    const primaryParsed = parseName(debtors[0] || "");
    const jointParsed = debtors[1] ? parseName(debtors[1]) : null;

    notes.push(
      `parsed case_name → ${debtors.length === 1 ? "single filer" : "joint filer"}: ` +
      `primary="${debtors[0]}"` + (debtors[1] ? `, joint="${debtors[1]}"` : "")
    );
    notes.push(
      `primary match pattern: contact_name LIKE %${primaryParsed.firstName}%${primaryParsed.lnameOnly}%`
    );

    let contactId = null;
    let matchedVia = null;

    let matches = await findContactsByName(req.db, primaryParsed);
    if (matches.length === 0 && jointParsed) {
      notes.push(`no primary match; trying joint pattern: contact_name LIKE %${jointParsed.firstName}%${jointParsed.lnameOnly}%`);
      const jm = await findContactsByName(req.db, jointParsed);
      if (jm.length) { matches = jm; matchedVia = "joint"; }
    } else if (matches.length) {
      matchedVia = "primary";
    }

    if (matches.length >= 2) {
      notes.push(`AMBIGUOUS: ${matches.length} contacts match — live route returns 409 and logs an alert; no write`);
      console.log(
        `[petitionTest] (dry-run) AMBIGUOUS contact for "${caseName}" (docket ${caseNumber}): ` +
        `${matches.length} matches [${matches.map(m => m.contact_id).join(", ")}]`
      );
      return res.status(409).json({
        status: "error",
        dry_run: true,
        message: `multiple contacts match "${caseName}" — needs human review`,
        candidates: matches.map(m => ({ contact_id: m.contact_id, contact_name: m.contact_name })),
        docket: caseNumber,
        plan: { action: "abort_ambiguous_contact", would_write_sql: [], notes },
      });
    }

    let wouldCreateContact = false;
    let contactPayload = null;

    if (matches.length === 1) {
      contactId = matches[0].contact_id;
      notes.push(`matched contact ${contactId} ("${matches[0].contact_name}") via ${matchedVia}`);
    } else {
      // 0 matches → live route WOULD create a contact. Dry run does not.
      wouldCreateContact = true;
      matchedVia = "created";
      contactPayload = {
        fname: primaryParsed.firstName,
        mname: primaryParsed.middleName,
        lname: primaryParsed.lastName,
        phone: "",
        email: "",
        type: "Client",
      };
      notes.push(`NO contact match — live route WOULD create a new contact from primary debtor (and log an alert). Dry run skips creation; downstream collision/case checks below assume a brand-new contact (no prior cases).`);
      console.log(
        `[petitionTest] (dry-run) NO contact match for "${caseName}" (docket ${caseNumber}) — would create contact`
      );
    }

    // ─────────────────────────────────────
    // STEP 3 — Docket collision check (READ ONLY)
    // ─────────────────────────────────────
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
      if (!wouldCreateContact && c.client_id != null && c.client_id === contactId) {
        notes.push(`docket ${caseNumber} already on case ${c.case_id} for THIS client → live route is idempotent (no-op)`);
        return res.json({
          status: "success",
          dry_run: true,
          message: `case ${c.case_id} already filed under docket ${caseNumber}`,
          action: "already_filed",
          id: c.case_id,
          case_id: c.case_id,
          contact_id: contactId,
          docket: caseNumber,
          plan: { action: "no_op_already_filed", would_write_sql: [], notes },
        });
      }
      notes.push(`DOCKET COLLISION: ${caseNumber} already on case ${c.case_id} (client ${c.client_id}) but petition resolves to a different client → live route returns 409 + alert; no write`);
      console.log(
        `[petitionTest] (dry-run) DOCKET COLLISION: ${caseNumber} on case ${c.case_id} (client ${c.client_id})`
      );
      return res.status(409).json({
        status: "error",
        dry_run: true,
        message: `docket ${caseNumber} already in use by case ${c.case_id} for a different client — needs human review`,
        conflict: { case_id: c.case_id, client_id: c.client_id },
        resolved_contact_id: wouldCreateContact ? "(new contact — not yet created)" : contactId,
        plan: { action: "abort_docket_collision", would_write_sql: [], notes },
      });
    }
    notes.push(`docket ${caseNumber} not found on any existing case — clear to proceed`);

    // ─────────────────────────────────────
    // STEP 4 — Find the waiting (pre-filing) case (READ ONLY)
    // ─────────────────────────────────────
    let existing = [];
    if (wouldCreateContact) {
      // Brand-new contact would have no cases; skip the lookup (mirrors reality).
      notes.push(`(new contact would have no prior cases — skipping waiting-case lookup)`);
    } else {
      const [rows] = await req.db.query(
        `SELECT c.case_id, c.case_type, c.case_stage, c.case_open_date, c.case_number, c.case_number_full
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
      existing = rows;
    }

    if (existing.length) {
      // ── Would STAMP the waiting case ──
      const target = existing[0];
      notes.push(`found waiting case ${target.case_id} (stage=${target.case_stage}, type="${target.case_type}") → live route WOULD stamp it and advance to Filed`);

      const wouldWrite = [
        {
          desc: "UPDATE cases (stamp docket + advance stage)",
          sql:
            `UPDATE cases SET case_number=?, case_type=?, case_chapter=?, case_stage='Filed', ` +
            `case_file_date=${fileDate ? "?" : "CONVERT_TZ(NOW(),'UTC','America/New_York')"} WHERE case_id=?`,
          params: [caseNumber, caseTypeFull, chapter, ...(fileDate ? [fileDate] : []), target.case_id],
        },
        {
          desc: "INSERT log (petition_stamped)",
          sql: `INSERT INTO log (log_type, log_date, log_link, log_by, log_data) VALUES ('update', CONVERT_TZ(NOW(),'UTC','America/New_York'), ?, 0, ?)`,
          params: [target.case_id, { action: "petition_stamped", case_number: caseNumber, case_type: caseTypeFull, chapter, contact_id: contactId, matched_via: matchedVia }],
        },
      ];

      return res.json({
        status: "success",
        dry_run: true,
        message: `[DRY RUN] would stamp docket ${caseNumber} onto case ${target.case_id} and set stage → Filed`,
        action: "stamped",
        id: target.case_id,
        case_id: target.case_id,
        contact_id: contactId,
        case_type: caseTypeFull,
        chapter,
        matched_via: matchedVia,
        plan: {
          action: "stamp_existing_case",
          target_case: {
            case_id: target.case_id,
            from: { case_stage: target.case_stage, case_type: target.case_type, case_number: target.case_number },
            to:   { case_stage: "Filed", case_type: caseTypeFull, case_number: caseNumber, case_chapter: chapter, case_file_date: fileDateDisplay },
          },
          would_write_sql: wouldWrite,
          notes,
        },
      });
    }

    // ─────────────────────────────────────
    // STEP 4b — No waiting case → would CREATE a new Filed case
    // ─────────────────────────────────────
    notes.push(`no waiting Open/Pending bankruptcy case → live route WOULD create a new case @ Filed + case_relate`);

    const wouldWrite = [];
    if (wouldCreateContact) {
      wouldWrite.push({
        desc: "contactService.createContact(...)",
        sql: "(service call — inserts a row in contacts)",
        params: contactPayload,
      });
    }
    wouldWrite.push(
      {
        desc: "INSERT cases (new Filed case; case_id generated)",
        sql:
          `INSERT INTO cases (case_id, case_open_date, case_file_date, case_type, case_chapter, case_stage, case_number) ` +
          `VALUES (<generated>, CONVERT_TZ(NOW(),'UTC','America/New_York'), ${fileDate ? "?" : "CONVERT_TZ(NOW(),'UTC','America/New_York')"}, ?, ?, 'Filed', ?)`,
        params: [...(fileDate ? [fileDate] : []), caseTypeFull, chapter, caseNumber],
      },
      {
        desc: "INSERT case_relate (Primary link)",
        sql: `INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (<new case_id>, ?, 'Primary')`,
        params: [wouldCreateContact ? "(new contact_id)" : contactId],
      },
      {
        desc: "INSERT log (petition_case_created)",
        sql: `INSERT INTO log (log_type, log_date, log_link, log_by, log_data) VALUES ('update', CONVERT_TZ(NOW(),'UTC','America/New_York'), <new case_id>, 0, ?)`,
        params: [{ action: "petition_case_created", case_number: caseNumber, case_type: caseTypeFull, chapter, contact_id: wouldCreateContact ? "(new)" : contactId, matched_via: matchedVia }],
      }
    );

    return res.json({
      status: "success",
      dry_run: true,
      message: `[DRY RUN] no waiting case found; would create a new Filed case under docket ${caseNumber}`,
      action: "created",
      id: "(new case_id — not generated in dry run)",
      case_id: "(new case_id — not generated in dry run)",
      contact_id: wouldCreateContact ? "(new contact — not created in dry run)" : contactId,
      case_type: caseTypeFull,
      chapter,
      matched_via: matchedVia,
      plan: {
        action: wouldCreateContact ? "create_contact_and_case" : "create_case",
        would_create_contact: wouldCreateContact,
        contact_payload: contactPayload,
        new_case: { case_type: caseTypeFull, case_chapter: chapter, case_stage: "Filed", case_number: caseNumber, case_file_date: fileDateDisplay },
        would_write_sql: wouldWrite,
        notes,
      },
    });

  } catch (err) {
    console.error("POST /api/intake/petitionTest error:", err);
    res.status(500).json({ status: "error", dry_run: true, message: "Failed to process petition (dry run)" });
  }
});

module.exports = router;