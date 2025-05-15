const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

let tokenData = null;
let refreshTimeout;
const TOKEN_PATH = path.join(__dirname, "..", "token.json");

const RINGCENTRAL_AUTH_URL = "https://platform.ringcentral.com/restapi/oauth/authorize";
const RINGCENTRAL_TOKEN_URL = "https://platform.ringcentral.com/restapi/oauth/token";

// --- Token Persistence ---
function loadToken() {
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const data = fs.readFileSync(TOKEN_PATH);
      tokenData = JSON.parse(data);
      console.log("Loaded token from disk.");
      scheduleRefresh();
    } catch (err) {
      console.error("Failed to load token:", err);
    }
  }
}

function saveToken() {
  try {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2));
    console.log("Token saved to disk.");
  } catch (err) {
    console.error("Failed to save token:", err);
  }
}

// --- Refresh Token Logic ---
function scheduleRefresh() {
  if (!tokenData || !tokenData.expires_in) return;
  const refreshTime = (tokenData.expires_in - 60) * 1000; // 1 minute before expiration
  clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(refreshAccessToken, refreshTime);
}

async function refreshAccessToken() {
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
      saveToken();
      scheduleRefresh();
      console.log("Token refreshed.");
    } else {
      const error = await res.text();
      console.error("Refresh failed:", error);
    }
  } catch (err) {
    console.error("Error refreshing token:", err);
  }
}

// --- Middleware for Testing API Key ---
function checkApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== process.env.RINGCENTRAL_API_KEY) {
    return res.status(403).json({ error: "Invalid API Key" });
  }
  next();
}

// --- Authorization URL Redirect ---
router.get("/ringcentral/authorize", (req, res) => {
  const authUrl = `${RINGCENTRAL_AUTH_URL}?response_type=code&client_id=${process.env.RINGCENTRAL_CLIENT_ID}&redirect_uri=${process.env.RINGCENTRAL_REDIRECT_URI}`;
  res.redirect(authUrl);
});

// --- OAuth Callback ---
router.get("/ringcentral/callback", async (req, res) => {
  const code = req.query.code;

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
      saveToken();
      scheduleRefresh();
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
  const from = req.body.from || req.query.from;
  const to = req.body.to || req.query.to;
  const message = req.body.message || req.query.message;

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

// --- Status ---
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

// --- Load token on startup ---
loadToken();

module.exports = router;
