// routes/auth.profile.js
//
/**
 * User Profile Route
 * ----------------------------------------
 * POST /api/auth/update-profile   (JWT-protected)
 *
 * Replaces the legacy Pabbly-based updateUserInfo flow.
 * Updates user info fields and re-derives user_name and user_initials.
 *
 * Body:
 *   user_fname          string   required
 *   user_lname          string   required
 *   username            string   required
 *   email               string   required
 *   phone               string   optional (10-digit, or empty)
 *   allow_sms           0 | 1
 *   task_remind_freq    string   comma-separated days, or empty
 *
 * TODO: audit-log profile changes (changed fields, acting user) via the
 *       upcoming jwtOrApiKey middleware logging once it lands.
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");

// Fields that must never leave the server in a user-row response.
// Mirrors USER_STRIP in routes/api.firmData.js.
const USER_STRIP = ["password", "password_hash", "reset_token", "reset_expires"];

function stripUser(row) {
  if (!row) return row;
  const clean = { ...row };
  for (const f of USER_STRIP) delete clean[f];
  return clean;
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

/**
 * Derive display name from first + last name.
 * "Fred" + "Smith" → "Fred Smith"
 */
function deriveName(fname, lname) {
  return [fname, lname].filter(Boolean).join(" ").trim();
}

/**
 * Derive initials from all words in fname + lname.
 * "Fred Gred" + "Smith" → "FGS"
 * "Mary" + "Jane Doe" → "MJD"
 */
function deriveInitials(fname, lname) {
  const allWords = `${fname || ""} ${lname || ""}`.trim().split(/\s+/);
  return allWords
    .map(w => w.charAt(0).toUpperCase())
    .join("")
    .slice(0, 3); // column is varchar(3)
}

/**
 * Normalize phone: strip non-digits, must be exactly 10 or empty.
 * Returns cleaned 10-digit string or null.
 */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (digits.length !== 10) return false; // signals validation error
  return digits;
}


// ─────────────────────────────────────────
// POST /api/auth/update-profile
// ─────────────────────────────────────────
router.post("/api/auth/update-profile", jwtOrApiKey, async (req, res) => {
  const userId = req.auth.userId; // PK from JWT

  const {
    user_fname,
    user_lname,
    username,
    email,
    phone,
    allow_sms,
    task_remind_freq,
    default_email,
    default_phone
  } = req.body;

  // ── Validation ──
  if (!user_fname || !user_lname || !username || !email) {
    return res.status(400).json({ error: "First name, last name, username, and email are required" });
  }

  const sms = allow_sms === 1 || allow_sms === "1" ? 1 : 0;

  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone === false) {
    return res.status(400).json({ error: "Phone number must be exactly 10 digits" });
  }

  if (sms === 1 && !normalizedPhone) {
    return res.status(400).json({ error: "Phone number is required when SMS reminders are enabled" });
  }

  try {
    // ── Check username uniqueness (if changed) ──
    const [[currentUser]] = await req.db.query(
      "SELECT username FROM users WHERE user = ?",
      [userId]
    );

    if (!currentUser) {
      return res.status(404).json({ error: "User not found" });
    }

    if (username !== currentUser.username) {
      const [existing] = await req.db.query(
        "SELECT user FROM users WHERE username = ? AND user != ?",
        [username, userId]
      );
      if (existing.length) {
        return res.status(409).json({ error: "That username is already taken" });
      }
    }

    // ── Derive computed fields ──
    const user_name = deriveName(user_fname, user_lname);
    const user_initials = deriveInitials(user_fname, user_lname);

    // Normalize task_remind_freq: comma-separated day names or empty string
    // Column is SET type, so MySQL expects comma-separated or empty
    const freq = task_remind_freq || "";

    // ── Default senders (self-service) ──
    // These only preselect send pickers — they grant no permissions (every
    // user can already choose any sender on any send screen), which is why
    // self-service is safe. Signature EDIT rights are deliberately NOT
    // derived from default_email (see routes/api.mySignatures.js) — they
    // anchor to the SU-assigned email_credentials.owner_user instead.
    //
    // BACK-COMPAT: columns are written ONLY when their key is present in the
    // body. A caller that never heard of these fields (old cached client,
    // other integrations) must not silently NULL a user's defaults.
    const hasDefEmail = 'default_email' in req.body;
    const hasDefPhone = 'default_phone' in req.body;
    const defEmail = hasDefEmail ? (default_email || null) : undefined;
    const defPhone = hasDefPhone
      ? (default_phone ? String(default_phone).replace(/\D/g, "").slice(-10) : null)
      : undefined;
    if (defEmail) {
      const [[cred]] = await req.db.query(
        "SELECT id FROM email_credentials WHERE email = ? LIMIT 1",
        [defEmail]
      );
      if (!cred) {
        return res.status(400).json({ error: "Default email must be one of the configured sending addresses" });
      }
    }
    if (defPhone) {
      const [[line]] = await req.db.query(
        "SELECT id FROM phone_lines WHERE phone_number = ? AND active = 1 LIMIT 1",
        [defPhone]
      );
      if (!line) {
        return res.status(400).json({ error: "Default SMS line must be one of the active phone lines" });
      }
    }

    // TODO: audit-log this change via the upcoming jwtOrApiKey middleware logging.

    // ── Update ── (defaults only when provided; see back-compat note above)
    const sets = [
      "user_fname = ?", "user_lname = ?", "user_name = ?", "user_initials = ?",
      "username = ?", "email = ?", "phone = ?", "allow_sms = ?", "task_remind_freq = ?",
    ];
    const vals = [user_fname, user_lname, user_name, user_initials, username, email, normalizedPhone, sms, freq];
    if (hasDefEmail) { sets.push("default_email = ?"); vals.push(defEmail); }
    if (hasDefPhone) { sets.push("default_phone = ?"); vals.push(defPhone); }
    vals.push(userId);
    await req.db.query(
      `UPDATE users SET ${sets.join(", ")} WHERE user = ?`,
      vals
    );

    // ── Return updated user row, stripped of credential fields ──
    // (Previously returned SELECT * raw, which leaked password, password_hash,
    //  and reset_token to the client. Stripped to match api.firmData.js.)
    const [[updated]] = await req.db.query(
      "SELECT * FROM users WHERE user = ?",
      [userId]
    );

    res.json({
      status: "success",
      message: "Profile updated successfully",
      user: stripUser(updated)
    });

  } catch (err) {
    console.error("update-profile error:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

module.exports = router;