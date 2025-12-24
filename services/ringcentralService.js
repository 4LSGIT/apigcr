/**
 * RingCentral Service
 * ------------------------------------------------------
 * Handles:
 * - Token load/save from DB
 * - Token refresh logic
 * - Sending SMS (with rate limiting)
 * - Alerts
 *
 * Exports async functions usable by routes or internally.
 */

const fetch = require("node-fetch");
const Bottleneck = require("bottleneck");

const ALERT_URL =
  "https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjYwNTZhMDYzMTA0M2Q1MjY5NTUzNjUxMzUi_pc";
const RINGCENTRAL_TOKEN_URL =
  "https://platform.ringcentral.com/restapi/oauth/token";

//const smsLimiter = new Bottleneck({ maxConcurrent: 2, minTime: 200 });
const smsLimiter = new Bottleneck({ maxConcurrent: 1, minTime: 1875 });

let tokenData = null;
let refreshTimeout = null;
let isRefreshing = false;
let refreshPromise = null;

// -------------------- Utils --------------------
function normalizeNumber(num) {
  if (!num) return null;
  let cleaned = num.toString().replace(/\D/g, "");
  if (cleaned.length === 11 && cleaned.startsWith("1")) return `+${cleaned}`;
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (num.startsWith("+")) return num;
  return null;
}

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

// -------------------- DB Helpers --------------------
async function getSetting(db, key) {
  const [rows] = await db.query("SELECT value FROM app_settings WHERE `key` = ?", [key]);
  return rows.length ? rows[0].value : null;
}

async function setSetting(db, key, value) {
  await db.query(
    "REPLACE INTO app_settings (`key`, `value`) VALUES (?, ?)",
    [key, value]
  );
}

// -------------------- TOKEN PERSISTENCE --------------------
async function saveToken(db) {
  if (!tokenData) return;
  try {
    await setSetting(db, "rc_token", JSON.stringify(tokenData));
  } catch (err) {
    console.error("Failed to save token:", err);
    sendAlert("token_save_failed", "Failed to save token to DB", { error: err.message });
  }
}

// -------------------- TOKEN REFRESH --------------------
async function refreshAccessToken(db) {
  if (!tokenData?.refresh_token) return;
  if (isRefreshing) return refreshPromise;

  isRefreshing = true;
  refreshPromise = (async () => {
    try {
      const refreshIssuedAt = tokenData.refresh_issued_at || tokenData.issued_at || Date.now();
      const refreshExpiry = refreshIssuedAt + (tokenData.refresh_token_expires_in || 0) * 1000;

      if (Date.now() >= refreshExpiry) {
        console.error("Refresh token expired, reauthorization required.");
        sendAlert("refresh_token_expired", "Refresh token has expired.");
        tokenData = null;
        clearTimeout(refreshTimeout);
        return;
      }

      const res = await fetch(RINGCENTRAL_TOKEN_URL, {
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
      tokenData = { ...json, access_issued_at: Date.now(), refresh_issued_at: Date.now() };
      await saveToken(db);
      scheduleRefresh(db);
    } catch (err) {
      console.error("Error refreshing token:", err);
      sendAlert("token_refresh_failed", err.message);
    } finally {
      isRefreshing = false;
    }
  })();

  return refreshPromise;
}

function scheduleRefresh(db) {
  if (!tokenData?.expires_in) return;
  clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(() => refreshAccessToken(db), (tokenData.expires_in - 600) * 1000);
}

// -------------------- LOAD TOKEN --------------------
async function loadToken(db) {
  if (tokenData) return;

  try {
    const raw = await getSetting(db, "rc_token");
    if (!raw) return;

    tokenData = JSON.parse(raw);

    const accessIssuedAt = tokenData.access_issued_at || tokenData.issued_at || Date.now();
    const accessExpiry = accessIssuedAt + (tokenData.expires_in || 0) * 1000;

    if (Date.now() >= accessExpiry) {
      // Attempt refresh but do not throw — prevent middleware hang
      try {
        await refreshAccessToken(db);
      } catch (err) {
        console.error("Token refresh failed on load:", err.message);
      }
    } else {
      scheduleRefresh(db);
    }
  } catch (err) {
    console.error("Failed to load token:", err.message);
    sendAlert("token_load_failed", err.message);
  }
}

// -------------------- SEND SMS --------------------
const sendSmsThroughLimiter = smsLimiter.wrap(async (from, to, message) => {
  const res = await fetch(
    "https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenData.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text: message }),
    }
  );

  if (!res.ok) throw new Error(await res.text());
  return res.json();
});

async function sendSms(db, from, to, message) {
  from = normalizeNumber(from);
  to = normalizeNumber(to);

  if (!from || !to || !message) throw new Error("Missing required fields");
  if (message.length > 1000) throw new Error("Message too long");

  if (!tokenData || Date.now() >= (tokenData.access_issued_at || 0) + (tokenData.expires_in || 0) * 1000) {
    await refreshAccessToken(db);
    if (!tokenData?.access_token) throw new Error("Not authorized");
  }

  const result = await sendSmsThroughLimiter(from, to, message);

  // Log SMS asynchronously
  db.query(
    "INSERT INTO rc_sms_log (from_number, to_number, message, status, rc_id) VALUES (?, ?, ?, 'success', ?)",
    [from, to, message, result.id],
    err => { if (err) console.error("Failed to log SMS:", err); }
  );

  return result;
}

async function exchangeCodeForToken(db, code) {
  const res = await fetch(RINGCENTRAL_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${process.env.RINGCENTRAL_CLIENT_ID}:${process.env.RINGCENTRAL_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.RINGCENTRAL_REDIRECT_URI
    }),
  });
  const json = await res.json();
  tokenData = { ...json, access_issued_at: Date.now(), refresh_issued_at: Date.now() };
  await saveToken(db);
  scheduleRefresh(db);
}

// -------------------- EXPORT --------------------
module.exports = {
  loadToken,
  sendSms,
  refreshAccessToken,
  exchangeCodeForToken,
  get tokenData() { return tokenData; }
};
