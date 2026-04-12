/**
 * Password Routes
 * ----------------------------------------
 * POST /auth/forgot-password    (public)  — send reset email
 * POST /auth/reset-password     (public)  — consume token, set new password
 * POST /api/auth/change-password (JWT)    — logged-in password change
 *
 * DUAL-WRITE NOTE:
 *   Both `password` (plaintext) and `password_hash` (bcrypt) are written on
 *   every password change. Lines marked with:
 *       // TODO: REMOVE when dropping plaintext password column
 *   should be deleted once all legacy routes use password_hash exclusively.
 *
 * RATE LIMITING NOTE:
 *   The public endpoints (/auth/forgot-password, /auth/reset-password) should
 *   be protected by express-rate-limit in production. Example:
 *     const rateLimit = require('express-rate-limit');
 *     const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
 *     router.post('/auth/forgot-password', resetLimiter, async (req, res) => { ... });
 */

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const emailService = require("../services/emailService");

const BCRYPT_ROUNDS = 12;
const RESET_EXPIRY_MINUTES = 60;
const FROM_EMAIL = process.env.AUTO_EMAIL || "automations@4lsg.com";
const IT_EMAIL = process.env.IT_EMAIL || "IT@4lsg.com";
const BASE_URL = process.env.APP_URL || "https://app.4lsg.com";

// ─────────────────────────────────────────
// POST /auth/forgot-password  (public)
// Body: { identifier }  — username or email
// ─────────────────────────────────────────
router.post("/auth/forgot-password", async (req, res) => {
  const { identifier } = req.body;

  if (!identifier) {
    return res.status(400).json({ error: "Please provide a username or email" });
  }

  // Always return the same response regardless of whether the user exists
  const genericOk = {
    status: "success",
    message: "If an account matches, a reset link has been sent."
  };

  try {
    // Look up by username OR email
    const [rows] = await req.db.query(
      "SELECT user, username, email FROM users WHERE username = ? OR email = ? LIMIT 1",
      [identifier, identifier]
    );

    if (!rows.length || !rows[0].email) {
      // No user or no email on file — still return generic response
      return res.json(genericOk);
    }

    const user = rows[0];

    // Generate token and expiry
    const token = crypto.randomBytes(32).toString("hex"); // 64-char hex
    const expires = new Date(Date.now() + RESET_EXPIRY_MINUTES * 60 * 1000);

    await req.db.query(
      "UPDATE users SET reset_token = ?, reset_expires = ? WHERE user = ?",
      [token, expires, user.user]
    );

    const resetLink = `${BASE_URL}/reset-password?token=${token}`;

    // Send reset email to user (fire-and-forget after response)
    res.json(genericOk);

    // ── Post-response emails ──
    emailService.sendEmail(req.db, {
      from: FROM_EMAIL,
      to: user.email,
      subject: "Password Reset Request",
      html: `
        <p>Hello,</p>
        <p>A password reset was requested for the account <strong>${user.username}</strong>.</p>
        <p>Click the link below to reset your password. This link expires in ${RESET_EXPIRY_MINUTES} minutes.</p>
        <p><a href="${resetLink}">${resetLink}</a></p>
        <p>If you did not request this, you can safely ignore this email.</p>
      `
    }).catch(err => console.error("Failed to send reset email:", err.message));

    // Notify IT
    emailService.sendEmail(req.db, {
      from: FROM_EMAIL,
      to: IT_EMAIL,
      subject: `Password Reset Requested: ${user.username}`,
      text: `User "${user.username}" (email: ${user.email}) requested a password reset at ${new Date().toISOString()}.`
    }).catch(err => console.error("Failed to send IT notification:", err.message));

  } catch (err) {
    console.error("forgot-password error:", err);
    // Still return generic response — don't leak internal errors
    res.json(genericOk);
  }
});


// ─────────────────────────────────────────
// POST /auth/reset-password  (public)
// Body: { token, new_password }
// ─────────────────────────────────────────
router.post("/auth/reset-password", async (req, res) => {
  const { token, new_password } = req.body;

  if (!token || !new_password) {
    return res.status(400).json({ error: "Token and new password are required" });
  }

  if (new_password.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters" });
  }

  try {
    // Find user with valid, non-expired token
    const [rows] = await req.db.query(
      `SELECT user, username
       FROM users
       WHERE reset_token = ? AND reset_expires > NOW()
       LIMIT 1`,
      [token]
    );

    if (!rows.length) {
      return res.status(400).json({ error: "Invalid or expired reset link. Please request a new one." });
    }

    const user = rows[0];
    const hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);

    await req.db.query(
      `UPDATE users
       SET password_hash = ?,
           password = ?,       -- TODO: REMOVE when dropping plaintext password column
           reset_token = NULL,
           reset_expires = NULL
       WHERE user = ?`,
      [hash, new_password, user.user] // TODO: REMOVE new_password param when dropping plaintext column
    );

    res.json({ status: "success", message: "Password updated successfully." });

  } catch (err) {
    console.error("reset-password error:", err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});


// ─────────────────────────────────────────
// POST /api/auth/change-password  (protected)
// Body: { current_password, new_password }
// ─────────────────────────────────────────
router.post("/api/auth/change-password", jwtOrApiKey, async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ error: "Current and new password are required" });
  }

  if (new_password.length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters" });
  }

  // req.auth.sub is the user PK from the JWT
  const userId = req.auth.userId;
console.log(req.auth.userId);
  try {
    const [rows] = await req.db.query(
      "SELECT password_hash FROM users WHERE user = ?",
      [userId]
    );

    if (!rows.length || !rows[0].password_hash) {
      return res.status(400).json({ error: "Account not found" });
    }

    const ok = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);

    await req.db.query(
      `UPDATE users
       SET password_hash = ?,
           password = ?        -- TODO: REMOVE when dropping plaintext password column
       WHERE user = ?`,
      [hash, new_password, userId] // TODO: REMOVE new_password param when dropping plaintext column
    );

    res.json({ status: "success", message: "Password changed successfully." });

  } catch (err) {
    console.error("change-password error:", err);
    res.status(500).json({ error: "Failed to change password" });
  }
});

module.exports = router;