// routes/api.intake.petition.js
//
/**
 * Petition Intake Route (MIEB Voluntary Petition → case stamping)
 * ---------------------------------------------------------------
 * POST /api/intake/petition
 *
 * Consumes a MIEB "Voluntary Petition" court email and either STAMPS the docket
 * onto the client's waiting (pre-filing) case or creates a new filed case, then
 * ensures BOTH debtors (primary + optional joint spouse) are linked to the case.
 *
 * Does NOT reuse /api/intake/case (whose "docket ⇒ always insert" rule would
 * skip the waiting Open case). The Calendly find-or-reuse flow is untouched.
 *
 * ── DEBTOR ROLES (role-preserving) ──
 *   case_name is "Primary" or "Primary and Joint" / "Primary & Joint". The
 *   first-named debtor is the PRIMARY by filing convention. Primary and joint
 *   are resolved INDEPENDENTLY to their own roles — the joint is never promoted
 *   to Primary even if the primary name matches no contact.
 *
 *   Primary debtor → case_relate 'Primary':
 *     1 match  → use it.
 *     0 match  → create contact, alert (filing for an unknown client).
 *     2+ match → 409 + alert (don't guess which client a filing belongs to).
 *
 *   Joint debtor (only when case_name has "and"/"&") → case_relate 'Secondary':
 *     1 match  → link it.
 *     0 match  → create contact, link it (routine — a new spouse, no alert).
 *     2+ match → alert + link nothing (ambiguity on the spouse must not block
 *                the filing). [answer 2b]
 *
 * ── IDEMPOTENCY ──
 *   Petition emails re-fire (Pabbly retries / GAS re-runs). All links go through
 *   ensureRelate(), which skips insertion when a (case, client, type) link
 *   already exists. The docket-collision path is no longer a blind no-op: it
 *   BACKFILLS a missing secondary link (catches cases filed before this feature,
 *   or first-fires that crashed after stamping but before linking the spouse).
 *
 * ── STAGE SEMANTICS ──
 *   Match set is 'Open'/'Pending' (pre-filing) only. 'Filed'/'Closed' are
 *   completed matters → a new petition for that client opens a fresh case.
 *
 * ── INPUT (JSON body) ──
 *   case_name    REQUIRED  "Case Name:" cell. Single or "X and Y" / "X & Y".
 *   case_number  REQUIRED* short docket, e.g. "26-31193" (the real number).
 *   chapter      REQUIRED* "7" | "11" | "13".
 *   file_date    optional  "YYYY-MM-DD"; defaults to today ET.
 *   subject      optional  raw subject; fills case_number/chapter if absent.
 *   * required either directly or via a parseable `subject`.
 *
 * ── RESPONSES ──
 *   200 { action: "stamped"|"created"|"already_filed", id, case_id, primary, secondary, ... }
 *   400 bad/missing input
 *   409 ambiguous PRIMARY contact, or docket collision on a different client
 *   500 unexpected
 *
 * case_type stored as "Bankruptcy - Ch. 7" / "Bankruptcy - Ch. 13" (period +
 * space), matching production. Pre-filing cases are plain "Bankruptcy".
 * case_number_full left NULL here (derived later from a subsequent email).
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

function generateCaseId() {
  let id;
  do {
    id = crypto.randomBytes(6).toString("base64url").slice(0, 8);
  } while (id.includes("-") || id.includes("_"));
  return id;
}

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

/**
 * Normalize a filing date to 'YYYY-MM-DD'. Accepts:
 *   - "YYYY-MM-DD"  (already canonical)
 *   - "M/D/YYYY" / "MM/DD/YYYY"  (US format, as the MIEB email gives it, e.g. "5/18/2026")
 * Returns the canonical string, or null if absent/unparseable (caller then
 * falls back to today ET). Validates real calendar ranges to reject garbage.
 */
function normalizeFileDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return null;

  let y, mo, d;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);      // YYYY-MM-DD
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {  // M/D/YYYY
    mo = +m[1]; d = +m[2]; y = +m[3];
  } else {
    return null;
  }

  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2999) return null;
  const pad = n => String(n).padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/** name-LIKE lookup: contact_name LIKE %first%lnameOnly%. */
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

/**
 * Fetch full contact rows by id (for get_contacts). Returns a Map id→row.
 * Used only when the caller opts in, so Pabbly et al. don't need a second fetch.
 */
async function fetchContacts(db, ids) {
  const clean = [...new Set(ids.filter(id => Number.isInteger(id)))];
  if (clean.length === 0) return new Map();
  const placeholders = clean.map(() => "?").join(",");
  const [rows] = await db.query(
    `SELECT * FROM contacts WHERE contact_id IN (${placeholders})`,
    clean
  );
  return new Map(rows.map(r => [r.contact_id, r]));
}

/**
 * Idempotent case_relate link. Inserts (case, client, type) only if absent.
 * Returns { created: bool, case_relate_id? }.
 */
async function ensureRelate(db, caseId, clientId, type) {
  const [exists] = await db.query(
    `SELECT case_relate_id FROM case_relate
      WHERE case_relate_case_id = ? AND case_relate_client_id = ? AND case_relate_type = ?
      LIMIT 1`,
    [caseId, clientId, type]
  );
  if (exists.length) return { created: false, case_relate_id: exists[0].case_relate_id };
  const [r] = await db.query(
    `INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type)
     VALUES (?, ?, ?)`,
    [caseId, clientId, type]
  );
  return { created: true, case_relate_id: r.insertId };
}

/**
 * Resolve the JOINT/secondary debtor against an already-resolved case, applying
 * answer 2b (ambiguous → alert + link nothing). Creates the contact if absent.
 * Skips if the joint resolves to the same contact as the primary, or its name
 * doesn't parse to usable parts. Returns a summary object for the response.
 */
async function resolveAndLinkSecondary(db, jointParsed, caseId, primaryContactId, ctx) {
  const result = { present: true, status: null, contact_id: null, linked: false, name: ctx.rawName };

  if (!jointParsed || !jointParsed.firstName || !jointParsed.lnameOnly) {
    result.status = "unparseable";
    console.log(`[petition] joint debtor "${ctx.rawName}" did not parse to usable name parts (docket ${ctx.docket}) — skipped`);
    return result;
  }

  const matches = await findContactsByName(db, jointParsed);

  if (matches.length >= 2) {
    // 2b: alert, link nothing, do not block.
    result.status = "ambiguous";
    console.log(
      `[petition] AMBIGUOUS joint debtor "${ctx.rawName}" (docket ${ctx.docket}): ` +
      `${matches.length} matches [${matches.map(m => m.contact_id).join(", ")}] — linked nothing; needs human review`
    );
    result.candidates = matches.map(m => ({ contact_id: m.contact_id, contact_name: m.contact_name }));
    return result;
  }

  let secondaryId;
  if (matches.length === 1) {
    secondaryId = matches[0].contact_id;
    result.status = "matched";
  } else {
    const created = await contactService.createContact(db, {
      fname: jointParsed.firstName,
      mname: jointParsed.middleName,
      lname: jointParsed.lastName,
      phone: "",
      email: "",
      type: "Client",
    });
    secondaryId = created.contact_id;
    result.status = "created";
  }

  if (secondaryId === primaryContactId) {
    // Same person parsed as both — don't link the same contact twice.
    result.status = "same_as_primary";
    result.contact_id = secondaryId;
    console.log(`[petition] joint debtor resolved to the primary contact ${secondaryId} (docket ${ctx.docket}) — secondary link skipped`);
    return result;
  }

  const link = await ensureRelate(db, caseId, secondaryId, "Secondary");
  result.contact_id = secondaryId;
  result.linked = link.created;            // false if it already existed (backfill no-op)
  result.already_linked = !link.created;
  return result;
}

// ─────────────────────────────────────────
// POST /api/intake/petition
// ─────────────────────────────────────────
router.post("/api/intake/petition", jwtOrApiKey, async (req, res) => {
  // ── Input reconciliation ──
  const caseName = (typeof req.body.case_name === "string") ? req.body.case_name.trim() : "";
  const fromSubject = parseSubject(req.body.subject);

  let caseNumber = (typeof req.body.case_number === "string") ? req.body.case_number.trim() : "";
  if (!caseNumber && fromSubject.caseNumber) caseNumber = fromSubject.caseNumber;

  let chapter = normalizeChapter(req.body.chapter) || normalizeChapter(fromSubject.chapter);

  // file_date: accept M/D/YYYY or YYYY-MM-DD; null → fall back to today ET.
  const fileDate = normalizeFileDate(req.body.file_date);
  if (req.body.file_date != null && String(req.body.file_date).trim() !== "" && fileDate === null) {
    return res.status(400).json({ status: "error", message: "file_date must be YYYY-MM-DD or M/D/YYYY" });
  }

  if (!caseName)   return res.status(400).json({ status: "error", message: "case_name is required" });
  if (!caseNumber) return res.status(400).json({ status: "error", message: "case_number is required (or supply a parseable subject)" });
  if (caseNumber.length > 20) return res.status(400).json({ status: "error", message: "case_number exceeds 20 chars" });
  if (!chapter)    return res.status(400).json({ status: "error", message: "chapter is required (or supply a parseable subject)" });

  const caseTypeFull = `Bankruptcy - Ch. ${chapter}`;
  const fileDateSql = fileDate ? "?" : "CONVERT_TZ(NOW(), 'UTC', 'America/New_York')";
  const fileDateParam = fileDate ? [fileDate] : [];

  // Opt-in: return full contact row(s) so the caller needn't re-fetch.
  // Accepts get_contacts (preferred) or getContacts; truthy "true"/1/true.
  const gcRaw = req.body.get_contacts != null ? req.body.get_contacts : req.body.getContacts;
  const getContacts = gcRaw === true || gcRaw === 1 || gcRaw === "true" || gcRaw === "1";

  try {
    // ── Parse debtors ──
    const debtors = splitDebtors(caseName);
    const primaryParsed = parseName(debtors[0] || "");
    const jointRaw = debtors[1] || null;
    const jointParsed = jointRaw ? parseName(jointRaw) : null;

    // ─────────────────────────────────────
    // STEP 1 — Resolve PRIMARY contact (role: Primary)
    // ─────────────────────────────────────
    let contactId = null;
    let primaryStatus = null;   // 'matched' | 'created'
    const primaryMatches = await findContactsByName(req.db, primaryParsed);

    if (primaryMatches.length >= 2) {
      console.log(
        `[petition] AMBIGUOUS primary contact for "${debtors[0]}" (docket ${caseNumber}): ` +
        `${primaryMatches.length} matches [${primaryMatches.map(m => m.contact_id).join(", ")}] — needs human review`
      );
      return res.status(409).json({
        status: "error",
        message: `multiple contacts match primary debtor "${debtors[0]}" — needs human review`,
        candidates: primaryMatches.map(m => ({ contact_id: m.contact_id, contact_name: m.contact_name })),
        docket: caseNumber,
      });
    }

    if (primaryMatches.length === 1) {
      contactId = primaryMatches[0].contact_id;
      primaryStatus = "matched";
    } else {
      console.log(
        `[petition] NO primary contact match for "${debtors[0]}" (docket ${caseNumber}) — ` +
        `creating new contact; needs human review`
      );
      const created = await contactService.createContact(req.db, {
        fname: primaryParsed.firstName,
        mname: primaryParsed.middleName,
        lname: primaryParsed.lastName,
        phone: "",
        email: "",
        type: "Client",
      });
      contactId = created.contact_id;
      primaryStatus = "created";
    }

    // ─────────────────────────────────────
    // STEP 2 — Docket collision check
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
      if (c.client_id != null && c.client_id === contactId) {
        // Already filed under this client → idempotent, but BACKFILL secondary.
        await ensureRelate(req.db, c.case_id, contactId, "Primary"); // safety; normally present
        let secondary = { present: !!jointParsed };
        if (jointParsed) {
          secondary = await resolveAndLinkSecondary(
            req.db, jointParsed, c.case_id, contactId,
            { rawName: jointRaw, docket: caseNumber }
          );
        }
        let contactsBlock = {};
        if (getContacts) {
          const map = await fetchContacts(req.db, [contactId, secondary.contact_id]);
          contactsBlock = {
            primary_contact: map.get(contactId) || null,
            secondary_contact: secondary.contact_id ? (map.get(secondary.contact_id) || null) : null,
          };
        }
        return res.json({
          status: "success",
          message: `case ${c.case_id} already filed under docket ${caseNumber}` +
            (secondary.linked ? "; backfilled secondary link" : ""),
          action: "already_filed",
          id: c.case_id,
          case_id: c.case_id,
          contact_id: contactId,
          docket: caseNumber,
          primary: { contact_id: contactId, status: primaryStatus },
          secondary,
          ...contactsBlock,
        });
      }
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
    // STEP 3 — Find the waiting (pre-filing) case
    // ─────────────────────────────────────
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

    let caseId;
    let action;

    if (existing.length) {
      // ── STAMP the waiting case ──
      caseId = existing[0].case_id;
      action = "stamped";
      await req.db.query(
        `UPDATE cases
            SET case_number  = ?,
                case_type    = ?,
                case_chapter = ?,
                case_stage   = 'Filed',
                case_status  = 'Case Filed',
                case_file_date = ${fileDateSql}
          WHERE case_id = ?`,
        [caseNumber, caseTypeFull, chapter, ...fileDateParam, caseId]
      );
      // Primary link already exists (case was found via it); ensure for safety.
      await ensureRelate(req.db, caseId, contactId, "Primary");
    } else {
      // ── CREATE a new Filed case ──
      action = "created";
      let inserted = false, attempts = 0;
      while (!inserted && attempts < 10) {
        caseId = generateCaseId();
        attempts++;
        try {
          await req.db.query(
            `INSERT INTO cases
               (case_id, case_open_date, case_file_date, case_type, case_chapter, case_stage, case_status, case_number)
             VALUES
               (?, CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), ${fileDateSql}, ?, ?, 'Filed', 'Case Filed', ?)`,
            [caseId, ...fileDateParam, caseTypeFull, chapter, caseNumber]
          );
          inserted = true;
        } catch (err) {
          if (err.code !== "ER_DUP_ENTRY") throw err;
        }
      }
      if (!inserted) throw new Error("Failed to generate unique case ID after 10 attempts");
      await ensureRelate(req.db, caseId, contactId, "Primary");
    }

    // ─────────────────────────────────────
    // STEP 4 — Resolve + link SECONDARY debtor (role: Secondary)
    // ─────────────────────────────────────
    let secondary = { present: !!jointParsed };
    if (jointParsed) {
      secondary = await resolveAndLinkSecondary(
        req.db, jointParsed, caseId, contactId,
        { rawName: jointRaw, docket: caseNumber }
      );
    }

    // ─────────────────────────────────────
    // STEP 5 — Log
    // ─────────────────────────────────────
    await req.db.query(
      `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
       VALUES ('update', CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), ?, 0, ?)`,
      [
        caseId,
        JSON.stringify({
          action: action === "stamped" ? "petition_stamped" : "petition_case_created",
          case_number: caseNumber,
          case_type: caseTypeFull,
          chapter,
          primary: { contact_id: contactId, status: primaryStatus },
          secondary: jointParsed
            ? { status: secondary.status, contact_id: secondary.contact_id, linked: secondary.linked }
            : null,
        }),
      ]
    );

    let contactsBlock = {};
    if (getContacts) {
      const map = await fetchContacts(req.db, [contactId, secondary.contact_id]);
      contactsBlock = {
        primary_contact: map.get(contactId) || null,
        secondary_contact: secondary.contact_id ? (map.get(secondary.contact_id) || null) : null,
      };
    }

    return res.json({
      status: "success",
      message:
        action === "stamped"
          ? `docket ${caseNumber} stamped onto case ${caseId}; stage → Filed`
          : `no waiting case found; created filed case ${caseId} under docket ${caseNumber}`,
      action,
      id: caseId,
      case_id: caseId,
      contact_id: contactId,
      case_type: caseTypeFull,
      chapter,
      primary: { contact_id: contactId, status: primaryStatus },
      secondary,
      ...contactsBlock,
    });

  } catch (err) {
    console.error("POST /api/intake/petition error:", err);
    res.status(500).json({ status: "error", message: "Failed to process petition" });
  }
});

module.exports = router;