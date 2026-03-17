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
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");

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
    task_remind_freq
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

    // ── Update ──
    await req.db.query(
      `UPDATE users
       SET user_fname = ?,
           user_lname = ?,
           user_name = ?,
           user_initials = ?,
           username = ?,
           email = ?,
           phone = ?,
           allow_sms = ?,
           task_remind_freq = ?
       WHERE user = ?`,
      [user_fname, user_lname, user_name, user_initials, username, email, normalizedPhone, sms, freq, userId]
    );

    // ── Return updated user row (mirrors what Pabbly used to return) ──
    const [[updated]] = await req.db.query(
      "SELECT * FROM users WHERE user = ?",
      [userId]
    );

    res.json({
      status: "success",
      message: "Profile updated successfully",
      user: updated
    });

  } catch (err) {
    console.error("update-profile error:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

module.exports = router;