const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
require("dotenv").config();
let tokenData = null;
let cachedApiKey = null;
let refreshTimeout;
// --- URLs ---
const RINGCENTRAL_AUTH_URL =
  "https://platform.ringcentral.com/restapi/oauth/authorize";
const RINGCENTRAL_TOKEN_URL =
  "https://platform.ringcentral.com/restapi/oauth/token";
const ALERT_URL =
  "https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjYwNTZhMDYzMTA0M2Q1MjY5NTUzNjUxMzUi_pc";
// --- DB Helpers ---
async function getSetting(db, key) {
  return new Promise((resolve, reject) => {
    db.query(
      "SELECT value FROM app_settings WHERE `key` = ?",
      [key],
      (err, results) => {
        if (err) return reject(err);
        if (results.length === 0) return resolve(null);
        resolve(results[0].value);
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
// --- Webhook Alert Helper ---
async function sendAlert(errorType, message, extraData = {}) {
  try {
    fetch(ALERT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error_type: errorType,
        alert: message,
        environment: process.env.ENVIRONMENT || "undefined",
        timestamp: new Date().toISOString(),
        ...extraData,
      }),
    }).catch((err) => console.error("Failed to send alert webhook:", err));
  } catch (err) {
    console.error("Failed to send alert webhook:", err);
  }
}
// --- Retry Helper ---
async function fetchWithRetries(url, options, retries = 3, delay = 500) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} - ${await res.text()}`);
      }
      return res;
    } catch (err) {
      lastError = err;
      console.warn(`Fetch attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delay * attempt));
      }
    }
  }
  throw lastError;
}
// --- Token Save ---
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
// --- Token Refresh Lock ---
let isRefreshing = false;
let refreshPromise = null;
async function refreshAccessToken(db) {
  if (!tokenData || !tokenData.refresh_token) return;
  if (isRefreshing) {
    console.log("Token refresh already in progress, waiting...");
    return refreshPromise;
  }
  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const refreshIssuedAt = tokenData.issued_at || Date.now();
      const refreshExpiresIn = (tokenData.refresh_token_expires_in || 0) * 1000;
      const refreshExpiry = refreshIssuedAt + refreshExpiresIn;
      if (Date.now() >= refreshExpiry) {
        console.error("Refresh token expired, requiring reauthorization.");
        sendAlert("refresh_token_expired", "Refresh token has expired, reauthorization needed");
        tokenData = null;
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
      tokenData = {
        ...(await res.json()),
        issued_at: Date.now(),
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
// --- Schedule Refresh ---
function scheduleRefresh(db) {
  if (!tokenData || !tokenData.expires_in) return;
  const refreshTime = (tokenData.expires_in - 600) * 1000; // 10 min before expiry
  clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(() => refreshAccessToken(db), refreshTime);
}
// --- Token Load Lock ---
let isLoadingToken = false;
let loadTokenPromise = null;
async function loadToken(db) {
  if (isLoadingToken) {
    console.log("Token load already in progress, waiting...");
    return loadTokenPromise;
  }
  isLoadingToken = true;
  loadTokenPromise = (async () => {
    try {
      const raw = await getSetting(db, "rc_token");
      if (raw) {
        tokenData = JSON.parse(raw);
        console.log("Loaded token from DB.");
        const issuedAt = tokenData.issued_at || Date.now();
        const now = Date.now();
        const expiresIn = tokenData.expires_in * 1000;
        const tokenExpiry = issuedAt + expiresIn;
        // Check refresh token expiry as well
        const refreshIssuedAt = tokenData.issued_at || Date.now();
        const refreshExpiresIn = (tokenData.refresh_token_expires_in || 0) * 1000;
        const refreshExpiry = refreshIssuedAt + refreshExpiresIn;
        if (now >= refreshExpiry) {
          console.error("Refresh token expired on load, requiring reauthorization.");
          sendAlert("refresh_token_expired", "Refresh token expired on load, reauthorization needed");
          tokenData = null;
          return;
        }
        if (now >= tokenExpiry) {
          console.log("Access token expired on load, attempting refresh...");
          try {
            await refreshAccessToken(db);
          } catch (err) {
            console.error("Could not refresh token on load:", err.message);
            sendAlert("token_refresh_failed", "Token refresh failed on load", {
              error: err.message,
            });
            // clear token so /status shows not authorized
            tokenData = null;
          }
        } else {
          scheduleRefresh(db);
        }
      } else {
        console.warn("No token found in DB.");
      }
    } catch (err) {
      console.error("Failed to load token from DB:", err);
      sendAlert("token_load_failed", "Token load failed", {
        error: err.message,
      });
      // don’t rethrow — keep server alive
    } finally {
      isLoadingToken = false;
    }
  })();
  return loadTokenPromise;
}
async function loadTokenWithRetries(db, retries = 3, delay = 500) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await loadToken(db);
      return; // success
    } catch (err) {
      lastError = err;
      console.warn(`Token load attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delay * attempt));
      }
    }
  }
  console.error("Token load failed after retries:", lastError);
  sendAlert("token_load_failed", "Token load failed after retries", {
    error: lastError.message,
  });
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
    sendAlert("unauthorized_access", "Invalid API key attempt", {
      ip: req.ip,
      path: req.originalUrl,
      provided_key: key || null,
    });
    return res.status(403).json({ error: "Invalid API Key" });
  }
  next();
}
// --- Routes ---
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
    tokenData = {
      ...(await resToken.json()),
      issued_at: Date.now(),
    };
    await saveToken(db);
    scheduleRefresh(db);
    res.send("Authorization successful. You can now send SMS.");
  } catch (err) {
    console.error("OAuth error:", err);
    sendAlert("token_load_failed", "OAuth callback failed", {
      error: err.message,
    });
    res.status(500).send("Failed to retrieve token.");
  }
});
router.all("/ringcentral/send-sms", checkApiKey, async (req, res) => {
  const { from, to, message } = { ...req.query, ...req.body };
  if (!from || !to || !message) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const db = req.db;
  if (!tokenData || !tokenData.access_token) {
    return res.status(401).json({ error: "Not authorized with RingCentral" });
  }
  const now = Date.now();
  const issuedAt = tokenData.issued_at || now;
  const expiresIn = tokenData.expires_in * 1000;
  const tokenExpiry = issuedAt + expiresIn;
  if (now >= tokenExpiry) {
    console.log("Token expired during SMS send, refreshing...");
    try {
      await refreshAccessToken(db);
    } catch (err) {
      sendAlert(
        "token_refresh_failed",
        "Failed to refresh access token during SMS send",
        { from, to, message, error: err.message }
      );
      return res.status(401).json({ error: "Failed to refresh access token" });
    }
  }
  try {
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
    const result = await smsRes.json();
    res.json(result);
  } catch (err) {
    console.error("SMS send error:", err);
    sendAlert("sms_send_failed", "SMS send failed after retries", {
      from,
      to,
      message,
      error: err.message,
    });
    res.status(500).send("Error sending SMS.");
  }
});
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
      ? new Date(
          Number(issuedAt) + tokenData.refresh_token_expires_in * 1000
        ).toISOString()
      : "unknown",
  });
});
// --- Initial Token Load ---
router.use(async (req, res, next) => {
  if (!tokenData) {
    try {
      await loadTokenWithRetries(req.db);
    } catch (err) {
      console.error("Skipping token load (DB unavailable):", err.message);
      // important: do not throw here, let the server keep running
    }
  }
  next();
});
module.exports = router;
module.exports.loadTokenFromDb = loadToken;
