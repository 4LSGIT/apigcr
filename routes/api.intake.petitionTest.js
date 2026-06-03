// routes/api.intake.petitionTest.js
//
/**
 * Petition Intake Route — DRY RUN (read-only mirror of api.intake.petition.js)
 * ---------------------------------------------------------------------------
 * POST /api/intake/petitionTest
 *
 * Same resolution logic as the live route (incl. dual-debtor role-preserving
 * resolution and idempotent linking) but performs NO writes. Returns the same
 * response shape plus `dry_run: true` and a `plan` block: planned action, the
 * SQL/service calls it would run, and a `notes[]` decision trail.
 *
 * Input is identical: { case_name, case_number, chapter, file_date?, subject? }
 *
 * Because no rows are written, the dry run models a few "would-be" facts:
 *   - 0-match primary: reports "would create contact"; since a new contact has
 *     no cases, it proceeds down the new-case branch.
 *   - secondary linking: reports created vs already-linked by checking the
 *     existing case_relate (read-only).
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const { parseName } = require("../lib/parseName");

// ── helpers (mirrors of live route; write helpers replaced by read-only probes) ──

function splitDebtors(caseName) {
  return String(caseName).split(/\s+(?:and|&)\s+/i).map(s => s.trim()).filter(Boolean);
}
function parseSubject(subject) {
  const out = { caseNumber: null, chapter: null };
  if (!subject || typeof subject !== "string") return out;
  const num = subject.match(/\b(\d{2}-\d{5})\b/);
  if (num) out.caseNumber = num[1];
  const ch = subject.match(/\bCh\.?\s*(\d{1,2})\b/i) || subject.match(/Chapter\s+(\d{1,2})/i);
  if (ch) out.chapter = ch[1];
  return out;
}
function normalizeChapter(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/(\d{1,2})/);
  return m ? m[1] : null;
}
function normalizeFileDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  let y, mo, d, m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { mo = +m[1]; d = +m[2]; y = +m[3]; }
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2999) return null;
  const pad = n => String(n).padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}`;
}
async function findContactsByName(db, parsed) {
  const first = (parsed.firstName || "").trim();
  const last = (parsed.lnameOnly || "").trim();
  if (!first || !last) return [];
  const [rows] = await db.query(
    `SELECT contact_id, contact_name FROM contacts
      WHERE contact_name LIKE CONCAT('%', ?, '%', ?, '%')`,
    [first, last]
  );
  return rows;
}
/** read-only: does this (case, client, type) link already exist? */
async function relateExists(db, caseId, clientId, type) {
  if (caseId == null || clientId == null) return false;
  const [rows] = await db.query(
    `SELECT case_relate_id FROM case_relate
      WHERE case_relate_case_id = ? AND case_relate_client_id = ? AND case_relate_type = ? LIMIT 1`,
    [caseId, clientId, type]
  );
  return rows.length > 0;
}

/**
 * Dry-run secondary resolution. Mirrors live logic; never writes. caseId may be
 * null (new-case branch — no link can pre-exist). Pushes planned writes into
 * `wouldWrite` and human notes into `notes`.
 */
async function planSecondary(db, jointParsed, jointRaw, caseId, primaryContactId, docket, wouldWrite, notes) {
  const result = { present: true, status: null, contact_id: null, linked: false, name: jointRaw };

  if (!jointParsed || !jointParsed.firstName || !jointParsed.lnameOnly) {
    result.status = "unparseable";
    notes.push(`joint debtor "${jointRaw}" did not parse to usable name parts — would skip`);
    return result;
  }

  notes.push(`joint match pattern: contact_name LIKE %${jointParsed.firstName}%${jointParsed.lnameOnly}%`);
  const matches = await findContactsByName(db, jointParsed);

  if (matches.length >= 2) {
    result.status = "ambiguous";
    result.candidates = matches.map(m => ({ contact_id: m.contact_id, contact_name: m.contact_name }));
    notes.push(`AMBIGUOUS joint (${matches.length} matches) → live route alerts + links nothing [2b]`);
    return result;
  }

  let secondaryId, isNew = false;
  if (matches.length === 1) {
    secondaryId = matches[0].contact_id;
    result.status = "matched";
    notes.push(`joint matched contact ${secondaryId} ("${matches[0].contact_name}")`);
  } else {
    result.status = "created";
    secondaryId = "(new contact — not created in dry run)";
    isNew = true;
    notes.push(`no joint match → would CREATE spouse contact (no alert)`);
    wouldWrite.push({
      desc: "contactService.createContact(secondary)",
      sql: "(service call — inserts a row in contacts)",
      params: { fname: jointParsed.firstName, mname: jointParsed.middleName, lname: jointParsed.lastName, phone: "", email: "", type: "Client" },
    });
  }

  if (!isNew && secondaryId === primaryContactId) {
    result.status = "same_as_primary";
    result.contact_id = secondaryId;
    notes.push(`joint resolved to the PRIMARY contact ${secondaryId} → secondary link skipped`);
    return result;
  }

  result.contact_id = secondaryId;

  // Would we create the Secondary link, or does it already exist?
  const exists = isNew ? false : await relateExists(db, caseId, secondaryId, "Secondary");
  if (exists) {
    result.linked = false;
    result.already_linked = true;
    notes.push(`Secondary link already exists for case ${caseId} ↔ contact ${secondaryId} → backfill no-op`);
  } else {
    result.linked = true;
    notes.push(`would INSERT Secondary link: case ${caseId} ↔ contact ${secondaryId}`);
    wouldWrite.push({
      desc: "INSERT case_relate (Secondary)",
      sql: `INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (?, ?, 'Secondary')`,
      params: [caseId == null ? "(new case_id)" : caseId, secondaryId],
    });
  }
  return result;
}

// ─────────────────────────────────────────
// POST /api/intake/petitionTest
// ─────────────────────────────────────────
router.post("/api/intake/petitionTest", jwtOrApiKey, async (req, res) => {
  const notes = [];

  const caseName = (typeof req.body.case_name === "string") ? req.body.case_name.trim() : "";
  const fromSubject = parseSubject(req.body.subject);

  let caseNumber = (typeof req.body.case_number === "string") ? req.body.case_number.trim() : "";
  if (!caseNumber && fromSubject.caseNumber) { caseNumber = fromSubject.caseNumber; notes.push(`parsed case_number "${caseNumber}" from subject`); }

  const chapterDirect = normalizeChapter(req.body.chapter);
  let chapter = chapterDirect || normalizeChapter(fromSubject.chapter);
  if (!chapterDirect && chapter) notes.push(`parsed chapter "${chapter}" from subject`);

  const fileDate = normalizeFileDate(req.body.file_date);
  if (req.body.file_date != null && String(req.body.file_date).trim() !== "" && fileDate === null) {
    return res.status(400).json({ status: "error", dry_run: true, message: "file_date must be YYYY-MM-DD or M/D/YYYY" });
  }
  if (!caseName)   return res.status(400).json({ status: "error", dry_run: true, message: "case_name is required" });
  if (!caseNumber) return res.status(400).json({ status: "error", dry_run: true, message: "case_number is required (or supply a parseable subject)" });
  if (caseNumber.length > 20) return res.status(400).json({ status: "error", dry_run: true, message: "case_number exceeds 20 chars" });
  if (!chapter)    return res.status(400).json({ status: "error", dry_run: true, message: "chapter is required (or supply a parseable subject)" });

  const caseTypeFull = `Bankruptcy - Ch. ${chapter}`;
  const fileDateDisplay = fileDate ? fileDate : "CONVERT_TZ(NOW(),'UTC','America/New_York') [today ET]";

  try {
    const debtors = splitDebtors(caseName);
    const primaryParsed = parseName(debtors[0] || "");
    const jointRaw = debtors[1] || null;
    const jointParsed = jointRaw ? parseName(jointRaw) : null;

    notes.push(`parsed case_name → ${debtors.length === 1 ? "single filer" : "joint filer"}: primary="${debtors[0]}"` + (jointRaw ? `, joint="${jointRaw}"` : ""));
    notes.push(`primary match pattern: contact_name LIKE %${primaryParsed.firstName}%${primaryParsed.lnameOnly}%`);

    const wouldWrite = [];

    // ── STEP 1: primary ──
    let contactId = null;
    let primaryStatus = null;
    let primaryIsNew = false;
    const primaryMatches = await findContactsByName(req.db, primaryParsed);

    if (primaryMatches.length >= 2) {
      notes.push(`AMBIGUOUS primary (${primaryMatches.length} matches) → live route 409 + alert; no write`);
      return res.status(409).json({
        status: "error", dry_run: true,
        message: `multiple contacts match primary debtor "${debtors[0]}" — needs human review`,
        candidates: primaryMatches.map(m => ({ contact_id: m.contact_id, contact_name: m.contact_name })),
        docket: caseNumber,
        plan: { action: "abort_ambiguous_primary", would_write_sql: [], notes },
      });
    }

    if (primaryMatches.length === 1) {
      contactId = primaryMatches[0].contact_id;
      primaryStatus = "matched";
      notes.push(`primary matched contact ${contactId} ("${primaryMatches[0].contact_name}")`);
    } else {
      primaryStatus = "created";
      primaryIsNew = true;
      contactId = "(new primary contact — not created in dry run)";
      notes.push(`NO primary match → would CREATE contact + alert. New contact has no prior cases, so flow proceeds to the new-case branch.`);
      wouldWrite.push({
        desc: "contactService.createContact(primary)",
        sql: "(service call — inserts a row in contacts)",
        params: { fname: primaryParsed.firstName, mname: primaryParsed.middleName, lname: primaryParsed.lastName, phone: "", email: "", type: "Client" },
      });
    }

    // ── STEP 2: docket collision (read-only) ──
    const [clash] = await req.db.query(
      `SELECT c.case_id, cr.case_relate_client_id AS client_id
         FROM cases c
         LEFT JOIN case_relate cr ON cr.case_relate_case_id = c.case_id AND cr.case_relate_type = 'Primary'
        WHERE (c.case_number IS NOT NULL AND c.case_number <> '' AND c.case_number = ?)
           OR (c.case_number_full IS NOT NULL AND c.case_number_full <> '' AND c.case_number_full = ?)
        LIMIT 1`,
      [caseNumber, caseNumber]
    );

    if (clash.length) {
      const c = clash[0];
      if (!primaryIsNew && c.client_id != null && c.client_id === contactId) {
        notes.push(`docket ${caseNumber} already on case ${c.case_id} for THIS client → already_filed (idempotent); would still backfill secondary`);
        let secondary = { present: !!jointParsed };
        if (jointParsed) {
          secondary = await planSecondary(req.db, jointParsed, jointRaw, c.case_id, contactId, caseNumber, wouldWrite, notes);
        }
        return res.json({
          status: "success", dry_run: true,
          message: `[DRY RUN] case ${c.case_id} already filed under docket ${caseNumber}` + (secondary.linked ? "; would backfill secondary link" : ""),
          action: "already_filed",
          id: c.case_id, case_id: c.case_id, contact_id: contactId, docket: caseNumber,
          primary: { contact_id: contactId, status: primaryStatus },
          secondary,
          plan: { action: "already_filed_backfill", would_write_sql: wouldWrite, notes },
        });
      }
      notes.push(`DOCKET COLLISION: ${caseNumber} on case ${c.case_id} (client ${c.client_id}) ≠ resolved client → 409 + alert; no write`);
      return res.status(409).json({
        status: "error", dry_run: true,
        message: `docket ${caseNumber} already in use by case ${c.case_id} for a different client — needs human review`,
        conflict: { case_id: c.case_id, client_id: c.client_id },
        resolved_contact_id: contactId,
        plan: { action: "abort_docket_collision", would_write_sql: [], notes },
      });
    }
    notes.push(`docket ${caseNumber} not found on any case — clear to proceed`);

    // ── STEP 3: find waiting case (read-only; skipped for brand-new primary) ──
    let existing = [];
    if (primaryIsNew) {
      notes.push(`(new primary contact would have no cases — skipping waiting-case lookup)`);
    } else {
      const [rows] = await req.db.query(
        `SELECT c.case_id, c.case_type, c.case_stage, c.case_open_date, c.case_number
           FROM cases c
           LEFT JOIN case_relate cr ON c.case_id = cr.case_relate_case_id
          WHERE cr.case_relate_client_id = ?
            AND cr.case_relate_type = 'Primary'
            AND c.case_stage IN ('Open', 'Pending')
            AND (c.case_type = 'Bankruptcy' OR c.case_type LIKE 'Bankruptcy - Ch%')
          ORDER BY c.case_open_date DESC LIMIT 1`,
        [contactId]
      );
      existing = rows;
    }

    let action, caseIdForSecondary;

    if (existing.length) {
      // ── would STAMP ──
      const target = existing[0];
      action = "stamped";
      caseIdForSecondary = target.case_id;
      notes.push(`found waiting case ${target.case_id} (stage=${target.case_stage}, type="${target.case_type}") → would stamp + advance to Filed`);
      wouldWrite.push({
        desc: "UPDATE cases (stamp docket + advance stage)",
        sql: `UPDATE cases SET case_number=?, case_type=?, case_chapter=?, case_stage='Filed', case_status='Case Filed', case_file_date=${fileDate ? "?" : "CONVERT_TZ(NOW(),'UTC','America/New_York')"} WHERE case_id=?`,
        params: [caseNumber, caseTypeFull, chapter, ...(fileDate ? [fileDate] : []), target.case_id],
      });
      // primary link exists (found via it) — ensureRelate would be a no-op
      notes.push(`primary link already present on case ${target.case_id} (found via it) → no insert`);
    } else {
      // ── would CREATE new Filed case ──
      action = "created";
      caseIdForSecondary = null; // new id, not generated in dry run
      notes.push(`no waiting Open/Pending bankruptcy case → would create a new case @ Filed + Primary link`);
      wouldWrite.push({
        desc: "INSERT cases (new Filed case; case_id generated)",
        sql: `INSERT INTO cases (case_id, case_open_date, case_file_date, case_type, case_chapter, case_stage, case_status, case_number) VALUES (<generated>, CONVERT_TZ(NOW(),'UTC','America/New_York'), ${fileDate ? "?" : "CONVERT_TZ(NOW(),'UTC','America/New_York')"}, ?, ?, 'Filed', 'Case Filed', ?)`,
        params: [...(fileDate ? [fileDate] : []), caseTypeFull, chapter, caseNumber],
      });
      wouldWrite.push({
        desc: "INSERT case_relate (Primary)",
        sql: `INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (<new case_id>, ?, 'Primary')`,
        params: [primaryIsNew ? "(new primary contact_id)" : contactId],
      });
    }

    // ── STEP 4: secondary ──
    let secondary = { present: !!jointParsed };
    if (jointParsed) {
      secondary = await planSecondary(req.db, jointParsed, jointRaw, caseIdForSecondary, contactId, caseNumber, wouldWrite, notes);
    }

    // ── STEP 5: log (would write) ──
    wouldWrite.push({
      desc: "INSERT log (petition action)",
      sql: `INSERT INTO log (log_type, log_date, log_link, log_by, log_data) VALUES ('update', CONVERT_TZ(NOW(),'UTC','America/New_York'), ${caseIdForSecondary == null ? "<new case_id>" : "?"}, 0, ?)`,
      params: [
        ...(caseIdForSecondary == null ? [] : [caseIdForSecondary]),
        { action: action === "stamped" ? "petition_stamped" : "petition_case_created", case_number: caseNumber, case_type: caseTypeFull, chapter, primary: { contact_id: contactId, status: primaryStatus }, secondary: jointParsed ? { status: secondary.status, contact_id: secondary.contact_id, linked: secondary.linked } : null },
      ],
    });

    return res.json({
      status: "success", dry_run: true,
      message:
        action === "stamped"
          ? `[DRY RUN] would stamp docket ${caseNumber} onto case ${caseIdForSecondary}; stage → Filed`
          : `[DRY RUN] no waiting case found; would create a new Filed case under docket ${caseNumber}`,
      action,
      id: caseIdForSecondary == null ? "(new case_id — not generated in dry run)" : caseIdForSecondary,
      case_id: caseIdForSecondary == null ? "(new case_id — not generated in dry run)" : caseIdForSecondary,
      contact_id: contactId,
      case_type: caseTypeFull,
      chapter,
      primary: { contact_id: contactId, status: primaryStatus },
      secondary,
      plan: {
        action: action === "stamped" ? "stamp_existing_case" : (primaryIsNew ? "create_contact_and_case" : "create_case"),
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