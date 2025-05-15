const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

let tokenData = null;
let cachedApiKey = null;
let refreshTimeout;

// --- Token file fallback (optional if DB fails) ---
const TOKEN_PATH = path.join(__dirname, "..", "rc_token.json");

const RINGCENTRAL_AUTH_URL = "https://platform.ringcentral.com/restapi/oauth/authorize";
const RINGCENTRAL_TOKEN_URL = "https://platform.ringcentral.com/restapi/oauth/token";

// --- DB Settings Helpers ---
async function getSetting(db, key) {
  return new Promise((resolve, reject) => {
    db.query("SELECT value FROM app_settings WHERE `key` = ?", [key], (err, results) => {
      if (err) return reject(err);
      if (results.length === 0) return resolve(null);
      resolve(results[0].value);
    });
  });
}

async function setSetting(db, key, value) {
  return new Promise((resolve, reject) => {
    db.query(
      "REPLACE INTO app_settings (`key`, `value`) VALUES (?, ?)",
      [key, value],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

// --- Load Token from DB or Disk ---
async function loadToken(db) {
  try {
    const raw = await getSetting(db, "rc_token");
    if (raw) {
      tokenData = JSON.parse(raw);
      console.log("Loaded token from DB.");
      scheduleRefresh(db);
      return;
    }
  } catch (err) {
    console.error("Failed to load token from DB:", err);
  }

  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const data = fs.readFileSync(TOKEN_PATH);
      tokenData = JSON.parse(data);
      console.log("Loaded token from disk (fallback).");
      scheduleRefresh(db);
    } catch (err) {
      console.error("Failed to load token from disk:", err);
    }
  }
}

// --- Save Token to DB & Disk ---
async function saveToken(db) {
  try {
    await setSetting(db, "rc_token", JSON.stringify(tokenData));
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2));
    console.log("Token saved to DB and disk.");
  } catch (err) {
    console.error("Failed to save token:", err);
  }
}

// --- Token Auto Refresh ---
function scheduleRefresh(db) {
  if (!tokenData || !tokenData.expires_in) return;
  const refreshTime = (tokenData.expires_in - 600) * 1000; // 10 min before expiration
  clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(() => refreshAccessToken(db), refreshTime);
}

async function refreshAccessToken(db) {
  if (!tokenData || !tokenData.refresh_token) return;

  try {
    const res = await fetch(RINGCENTRAL_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${process.env.RINGCENTRAL_CLIENT_ID}:${process.env.RINGCENTRAL_CLIENT_SECRET}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenData.refresh_token
      })
    });

    if (res.ok) {
      tokenData = {
        ...await res.json(),
        issued_at: Date.now()
      };
      await saveToken(db);
      scheduleRefresh(db);
      console.log("Token refreshed.");
    } else {
      const error = await res.text();
      console.error("Refresh failed:", error);
    }
  } catch (err) {
    console.error("Error refreshing token:", err);
  }
}

// --- API Key Middleware ---
async function checkApiKey(req, res, next) {
  if (!cachedApiKey) {
    try {
      const dbKey = await getSetting(req.db, "api_key");
      cachedApiKey = dbKey || process.env.RINGCENTRAL_API_KEY;
    } catch (e) {
      console.error("Failed to load API key:", e);
      cachedApiKey = process.env.RINGCENTRAL_API_KEY;
    }
  }

  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== cachedApiKey) {
    return res.status(403).json({ error: "Invalid API Key" });
  }
  next();
}

// --- Authorize Manually ---
router.get("/ringcentral/authorize", (req, res) => {
  const authUrl = `${RINGCENTRAL_AUTH_URL}?response_type=code&client_id=${process.env.RINGCENTRAL_CLIENT_ID}&redirect_uri=${process.env.RINGCENTRAL_REDIRECT_URI}`;
  res.redirect(authUrl);
});

// --- OAuth Callback ---
router.get("/ringcentral/callback", async (req, res) => {
  const code = req.query.code;
  const db = req.db;

  try {
    const resToken = await fetch(RINGCENTRAL_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${process.env.RINGCENTRAL_CLIENT_ID}:${process.env.RINGCENTRAL_CLIENT_SECRET}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.RINGCENTRAL_REDIRECT_URI
      })
    });

    if (resToken.ok) {
      tokenData = {
        ...await resToken.json(),
        issued_at: Date.now()
      };
      await saveToken(db);
      scheduleRefresh(db);
      res.send("Authorization successful. You can now send SMS.");
    } else {
      const error = await resToken.text();
      console.error("OAuth error:", error);
      res.status(500).send("Failed to retrieve token.");
    }
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send("Callback handling error.");
  }
});

// --- Send SMS ---
router.all("/ringcentral/send-sms", checkApiKey, async (req, res) => {
  const { from, to, message } = { ...req.query, ...req.body };

  if (!from || !to || !message) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!tokenData || !tokenData.access_token) {
    return res.status(401).json({ error: "Not authorized with RingCentral" });
  }

  try {
    const smsRes = await fetch("https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: { phoneNumber: from },
        to: [{ phoneNumber: to }],
        text: message
      })
    });

    if (smsRes.ok) {
      const result = await smsRes.json();
      res.json(result);
    } else {
      const error = await smsRes.text();
      console.error("SMS error:", error);
      res.status(500).send("Failed to send SMS.");
    }
  } catch (err) {
    console.error("SMS send error:", err);
    res.status(500).send("Error sending SMS.");
  }
});

// --- Status Check ---
router.get("/ringcentral/status", checkApiKey, (req, res) => {
  if (!tokenData || !tokenData.access_token) {
    return res.json({ authorized: false });
  }

  const expiresIn = tokenData.expires_in || 0;
  const issuedAt = tokenData.issued_at || Date.now();
  const expiresAt = new Date(Number(issuedAt) + expiresIn * 1000);

  res.json({
    authorized: true,
    access_token_expires_at: expiresAt.toISOString(),
    refresh_token_expires_at: tokenData.refresh_token_expires_in
      ? new Date(Number(issuedAt) + tokenData.refresh_token_expires_in * 1000).toISOString()
      : "unknown"
  });
});

// --- Initial Token Load ---
router.use(async (req, res, next) => {
  if (!tokenData) await loadToken(req.db);
  next();
});

module.exports = router;
