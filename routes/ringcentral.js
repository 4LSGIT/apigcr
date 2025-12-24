const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const Bottleneck = require("bottleneck");
require("dotenv").config();

let tokenData = null;
let cachedApiKey = null;
let refreshTimeout = null;

// -------------------- URLs --------------------
const RINGCENTRAL_AUTH_URL =
  "https://platform.ringcentral.com/restapi/oauth/authorize";
const RINGCENTRAL_TOKEN_URL =
  "https://platform.ringcentral.com/restapi/oauth/token";
const ALERT_URL =
  "https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjYwNTZhMDYzMTA0M2Q1MjY5NTUzNjUxMzUi_pc";

// -------------------- SMS rate limiter --------------------
const smsLimiter = new Bottleneck({
  maxConcurrent: 2,
  minTime: 200
});

// -------------------- Utils --------------------
function normalizeNumber(num) {
  if (!num) return null;
  let cleaned = num.toString().replace(/\D/g, "");
  if (cleaned.length === 11 && cleaned.startsWith("1")) return `+${cleaned}`;
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (num.startsWith("+")) return num;
  return null;
}

// -------------------- DB Helpers --------------------
async function getSetting(db, key) {
  return new Promise((resolve, reject) => {
    db.query(
      "SELECT value FROM app_settings WHERE `key` = ?",
      [key],
      (err, results) => {
        if (err) return reject(err);
        resolve(results.length ? results[0].value : null);
      }
    );
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

// -------------------- Alerts --------------------
async function sendAlert(type, message, extra = {}) {
  try {
    await fetch(ALERT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error_type: type,
        alert: message,
        environment: process.env.ENVIRONMENT || "unknown",
        timestamp: new Date().toISOString(),
        ...extra,
      }),
    });
  } catch (_) {}
}

// -------------------- Fetch with retries & 429 --------------------
async function fetchWithRetries(url, options, retries = 3) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, options);

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After")) || i * 2;
        console.warn(`Rate limited. Retrying after ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      return res;
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise(r => setTimeout(r, i * 500));
    }
  }
  throw lastErr;
}

// -------------------- Token Persistence --------------------
async function saveToken(db) {
  try {
    await setSetting(db, "rc_token", JSON.stringify(tokenData));
    console.log("Token saved to DB.");
  } catch (err) {
    console.error("Failed to save token:", err);
    sendAlert("token_save_failed", "Failed to save token to DB", {
      error: err.message,
    });
  }
}

// -------------------- Token Refresh --------------------
let isRefreshing = false;
let refreshPromise = null;

async function refreshAccessToken(db) {
  if (!tokenData?.refresh_token) return;

  if (isRefreshing) return refreshPromise;

  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const refreshIssuedAt = tokenData.refresh_issued_at || tokenData.issued_at || Date.now();
      const refreshExpiry =
        refreshIssuedAt +
        (tokenData.refresh_token_expires_in || 0) * 1000;

      if (Date.now() >= refreshExpiry) {
        console.error("Refresh token expired, requiring reauthorization.");
        sendAlert("refresh_token_expired", "Refresh token has expired, reauthorization needed");
        tokenData = null;
        clearTimeout(refreshTimeout);
        return;
      }

      const res = await fetchWithRetries(RINGCENTRAL_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${process.env.RINGCENTRAL_CLIENT_ID}:${process.env.RINGCENTRAL_CLIENT_SECRET}`
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokenData.refresh_token,
        }),
      });

      const json = await res.json();
      tokenData = {
        ...json,
        access_issued_at: Date.now(),
        refresh_issued_at: Date.now()
      };

      await saveToken(db);
      scheduleRefresh(db);
      console.log("Token refreshed successfully.");
    } catch (err) {
      console.error("Error refreshing token:", err);
      sendAlert("token_refresh_failed", "Token refresh failed after retries", {
        error: err.message,
      });
      throw err;
    } finally {
      isRefreshing = false;
    }
  })();

  return refreshPromise;
}

// -------------------- Schedule Refresh --------------------
function scheduleRefresh(db) {
  if (!tokenData?.expires_in) return;
  clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(
    () => refreshAccessToken(db),
    (tokenData.expires_in - 600) * 1000
  );
}

// -------------------- Token Load --------------------
let isLoadingToken = false;
let loadTokenPromise = null;

async function loadToken(db) {
  if (isLoadingToken) return loadTokenPromise;

  isLoadingToken = true;
  loadTokenPromise = (async () => {
    try {
      const raw = await getSetting(db, "rc_token");
      if (raw) {
        tokenData = JSON.parse(raw);
        const accessIssuedAt = tokenData.access_issued_at || tokenData.issued_at || Date.now();
        if (!Number.isFinite(accessIssuedAt)) {
          console.log("Invalid access_issued_at, forcing refresh...");
          await refreshAccessToken(db);
        } else {
          const accessExpiry = accessIssuedAt + (tokenData.expires_in || 0) * 1000;
          if (Date.now() >= accessExpiry) {
            console.log("Access token expired on load, refreshing...");
            await refreshAccessToken(db);
          } else {
            scheduleRefresh(db);
          }
        }
      } else {
        console.warn("No token found in DB.");
      }
    } catch (err) {
      console.error("Failed to load token from DB:", err);
      sendAlert("token_load_failed", "Token load failed", { error: err.message });
    } finally {
      isLoadingToken = false;
    }
  })();

  return loadTokenPromise;
}

// -------------------- API Key Middleware --------------------
async function checkApiKey(req, res, next) {
  if (!cachedApiKey) {
    try {
      cachedApiKey = await getSetting(req.db, "api_key") || process.env.RINGCENTRAL_API_KEY;
    } catch (e) {
      console.error("Failed to load API key:", e);
      cachedApiKey = process.env.RINGCENTRAL_API_KEY;
    }
  }

  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== cachedApiKey) {
    sendAlert("unauthorized_access", "Invalid API key attempt", {
      ip: req.ip,
      path: req.originalUrl,
      provided_key: key || null,
    });
    return res.status(403).json({ error: "Invalid API Key" });
  }
  next();
}

// ==================== LOAD TOKEN FIRST ====================
router.use(async (req, res, next) => {
  if (!tokenData) {
    try {
      await loadToken(req.db);
    } catch (err) {
      console.error("Skipping token load (DB unavailable):", err.message);
    }
  }
  next();
});

// -------------------- OAuth Routes --------------------
router.get("/ringcentral/authorize", (req, res) => {
  const authUrl = `${RINGCENTRAL_AUTH_URL}?response_type=code&client_id=${process.env.RINGCENTRAL_CLIENT_ID}&redirect_uri=${process.env.RINGCENTRAL_REDIRECT_URI}`;
  res.redirect(authUrl);
});

router.get("/ringcentral/callback", async (req, res) => {
  if (req.query.error) {
    console.error("OAuth error from RingCentral:", req.query.error);
    sendAlert("oauth_error", "OAuth callback error from RingCentral", { error: req.query.error });
    return res.status(400).send("Authorization failed.");
  }
  const code = req.query.code;
  const db = req.db;
  try {
    const resToken = await fetchWithRetries(RINGCENTRAL_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.RINGCENTRAL_CLIENT_ID}:${process.env.RINGCENTRAL_CLIENT_SECRET}`
          ).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.RINGCENTRAL_REDIRECT_URI,
      }),
    });
    const json = await resToken.json();
    tokenData = {
      ...json,
      access_issued_at: Date.now(),
      refresh_issued_at: Date.now()
    };
    await saveToken(db);
    scheduleRefresh(db);
    res.send("Authorization successful. You can now send SMS.");
  } catch (err) {
    console.error("OAuth error:", err);
    sendAlert("token_load_failed", "OAuth callback failed", { error: err.message });
    res.status(500).send("Failed to retrieve token.");
  }
});

// -------------------- SEND SMS --------------------
const sendSmsThroughLimiter = smsLimiter.wrap(async (from, to, message) => {
  const smsRes = await fetchWithRetries(
    "https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: { phoneNumber: from },
        to: [{ phoneNumber: to }],
        text: message,
      }),
    }
  );
  return await smsRes.json();
});

router.all("/ringcentral/send-sms", checkApiKey, async (req, res) => {
  let { from, to, message } = { ...req.query, ...req.body };
  from = normalizeNumber(from);
  to = normalizeNumber(to);

  if (!from || !to || !message) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (message.length > 1000) return res.status(400).json({ error: "Message too long" });

  const accessIssuedAt = tokenData.access_issued_at || tokenData.issued_at || Date.now();
  const accessExpiry = accessIssuedAt + (tokenData.expires_in || 0) * 1000;
  if (Date.now() >= accessExpiry) {
    try {
      await refreshAccessToken(req.db);
      if (!tokenData?.access_token) return res.status(401).json({ error: "Not authorized" });
    } catch (err) {
      await sendAlert("token_refresh_failed", err.message, { from, to });
      return res.status(401).json({ error: "Token refresh failed" });
    }
  }

  try {
    const result = await sendSmsThroughLimiter(from, to, message);

    // Log success
    req.db.query(
      "INSERT INTO rc_sms_log (from_number, to_number, message, status, rc_id) VALUES (?, ?, ?, 'success', ?)",
      [from, to, message, result.id],
      err => { if (err) console.error("Failed to log SMS:", err); }
    );

    res.json(result);
  } catch (err) {
    // Log failure
    req.db.query(
      "INSERT INTO rc_sms_log (from_number, to_number, message, status, error) VALUES (?, ?, ?, 'failed', ?)",
      [from, to, message, err.message],
      logErr => { if (logErr) console.error("Failed to log SMS:", logErr); }
    );

    await sendAlert("sms_send_failed", err.message, { from, to });
    res.status(500).json({ error: "SMS send failed" });
  }
});

// -------------------- STATUS --------------------
router.get("/ringcentral/status", checkApiKey, (req, res) => {
  if (!tokenData?.access_token) return res.json({ authorized: false });

  const accessIssuedAt = Number(tokenData.access_issued_at || tokenData.issued_at) || 0;
  const accessExpiresIn = Number(tokenData.expires_in) || 0;
  const refreshIssuedAt = Number(tokenData.refresh_issued_at || tokenData.issued_at) || 0;
  const refreshExpiresIn = Number(tokenData.refresh_token_expires_in) || 0;

  let accessExpiresAt = "unknown";
  let refreshExpiresAt = "unknown";

  if (!isNaN(accessIssuedAt) && !isNaN(accessExpiresIn)) {
    accessExpiresAt = new Date(accessIssuedAt + accessExpiresIn * 1000).toISOString();
  }

  if (!isNaN(refreshIssuedAt) && !isNaN(refreshExpiresIn) && refreshExpiresIn > 0) {
    refreshExpiresAt = new Date(refreshIssuedAt + refreshExpiresIn * 1000).toISOString();
  }

  res.json({
    authorized: true,
    access_token_expires_at: accessExpiresAt,
    refresh_token_expires_at: refreshExpiresAt
  });
});


module.exports = router;
module.exports.loadTokenFromDb = loadToken;