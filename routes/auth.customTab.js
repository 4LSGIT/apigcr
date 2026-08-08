// routes/auth.customTab.js
//
/**
 * POST /api/auth/update-custom-tab   (JWT-protected, self-service)
 *
 * Lets a user choose the page, title and icon of their own custom tab —
 * users.user_custom_tab, a JSON column of shape { src, icon, title, loadFunc }.
 *
 * Body: { title, icon, src }   — or { clear: true } to remove the tab.
 * Returns: { status:'success', user_custom_tab }
 *
 * Auto-mounted from routes/ (server.js readdir loop).
 *
 * ── WHY THIS IS NOT A PASSTHROUGH ───────────────────────────────────────────
 * Every field on this row is consumed by the SHELL, not by a sandboxed page:
 *
 *   index.html applyCustomTab()  →  innerHTML `<i class="fa-solid fa-${icon}">
 *                                   <span>${title}</span>`
 *                                →  setAttribute('onclick', loadFunc + …)
 *                                →  iframe src
 *
 * While only an SU could write the row, that was trusted admin input. Making it
 * self-service turns each field into a PERSISTENT payload that re-runs on every
 * login, so a few seconds at an unlocked workstation would otherwise buy a
 * permanent foothold in trusted app chrome. Hence:
 *
 *   loadFunc  NEVER written here. Read from the existing row and written back
 *             untouched, so a user editing their title cannot destroy an
 *             admin-authored loadFunc — and cannot author one either.
 *   icon      /^[a-z0-9-]{1,40}$/ — matches every real Font Awesome name and
 *             nothing that can break out of the class attribute.
 *   title     trimmed, length-capped. Escaped again at render.
 *   src       SU: any http(s) URL or same-origin path.
 *             Non-SU: same-origin path only (see SAFE_PATH). That blocks
 *             javascript:/data: URIs (script execution in the shell's origin)
 *             and third-party embeds (a convincing fake login form inside
 *             trusted chrome, plus top-window navigation), while still allowing
 *             every page the app actually serves.
 *
 * EXISTING-VALUE ESCAPE HATCH: if the submitted src is byte-identical to the
 * one already stored, it is accepted without re-validation. An SU may
 * deliberately have set an external URL for a non-SU user; that user must still
 * be able to rename their tab without the save being rejected, and without
 * silently losing the admin's choice.
 *
 * ── mysql2 JSON HAZARD ──────────────────────────────────────────────────────
 * user_custom_tab is a JSON column: mysql2 returns it PARSED and requires it
 * JSON.stringify()'d on the way in.
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");

const MAX_TITLE = 40;
const MAX_SRC = 300;

// Font Awesome icon names: lowercase, digits, hyphens. Deliberately permissive
// enough for any real icon ("money-check-dollar", "1", "arrow-up-9-1") and
// narrow enough that the value can never terminate the class attribute.
const ICON_RE = /^[a-z0-9-]{1,40}$/;

// Same-origin path: one leading slash, not protocol-relative ("//evil.tld"),
// no scheme (no ':'), no backslash (some engines normalise "\\evil.tld" like
// "//"), no whitespace.
const SAFE_PATH = /^\/(?!\/)[^\s:\\]*$/;

// SU may also point at an absolute http(s) URL.
const ABSOLUTE_URL = /^https?:\/\/[^\s"'<>\\]+$/i;

/** Same SU test as routes/api.reports.js — user_auth on the JWT. */
function isSU(req) {
  return !!(req.auth && req.auth.type === "jwt" && req.auth.user_auth === "authorized - SU");
}

function fail(res, status, message, detail) {
  const body = { status: "error", message };
  if (detail) body.detail = detail;
  return res.status(status).json(body);
}

router.post("/api/auth/update-custom-tab", jwtOrApiKey, async (req, res) => {
  const userId = req.auth && req.auth.userId;
  if (userId == null) return fail(res, 401, "Not signed in");

  const { title, icon, src, clear } = req.body || {};

  try {
    // Existing row: needed for the preserved loadFunc and the unchanged-src
    // escape hatch.
    const [[row]] = await req.db.query(
      "SELECT user_custom_tab FROM users WHERE user = ? LIMIT 1",
      [userId]
    );
    if (!row) return fail(res, 404, "User not found");

    let existing = row.user_custom_tab;
    if (typeof existing === "string") {
      try { existing = JSON.parse(existing); } catch { existing = null; }
    }
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) existing = {};

    // ── Clear ────────────────────────────────────────────────────────────
    if (clear === true || (src != null && String(src).trim() === "" && !title && !icon)) {
      await req.db.query("UPDATE users SET user_custom_tab = NULL WHERE user = ?", [userId]);
      return res.json({ status: "success", user_custom_tab: null });
    }

    // ── Validate ─────────────────────────────────────────────────────────
    const cleanTitle = String(title ?? "").trim();
    if (!cleanTitle) return fail(res, 400, "Tab name is required");
    if (cleanTitle.length > MAX_TITLE) {
      return fail(res, 400, `Tab name must be ${MAX_TITLE} characters or fewer`);
    }

    const cleanIcon = String(icon ?? "").trim().toLowerCase().replace(/^fa-/, "");
    if (!ICON_RE.test(cleanIcon)) {
      return fail(
        res, 400,
        "Icon must be a Font Awesome name",
        "Lowercase letters, digits and hyphens only — for example: list-check, gavel, paw."
      );
    }

    const cleanSrc = String(src ?? "").trim();
    if (!cleanSrc) return fail(res, 400, "Pick what the tab should show");
    if (cleanSrc.length > MAX_SRC) return fail(res, 400, "That address is too long");

    const unchanged = existing.src != null && String(existing.src) === cleanSrc;
    if (!unchanged) {
      const ok = SAFE_PATH.test(cleanSrc) || (isSU(req) && ABSOLUTE_URL.test(cleanSrc));
      if (!ok) {
        return isSU(req)
          ? fail(res, 400, "That address is not valid",
                 "Use a path beginning with '/' or a full https:// URL.")
          : fail(res, 400, "That address is not allowed",
                 "Custom tabs point at pages inside YisraCase — a path beginning with '/'. " +
                 "Ask IT if you need an external site embedded.");
      }
    }

    // ── Write. loadFunc rides through untouched, never from the body. ────
    const next = {
      src: cleanSrc,
      icon: cleanIcon,
      title: cleanTitle,
      loadFunc: typeof existing.loadFunc === "string" ? existing.loadFunc : "",
    };

    await req.db.query(
      "UPDATE users SET user_custom_tab = ? WHERE user = ?",
      [JSON.stringify(next), userId]
    );

    return res.json({ status: "success", user_custom_tab: next });
  } catch (e) {
    console.error("[auth.customTab] update error:", e);
    return fail(res, 500, "Could not save the custom tab");
  }
});

module.exports = router;