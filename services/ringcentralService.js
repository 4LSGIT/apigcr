/**
 * RingCentral Service
 * ------------------------------------------------------
 * Combines:
 * - Logging of token refreshes and auth exchanges (DB)
 * - SMS & MMS sending (with rate limiting)
 * - Alerts
 */

const fetch = require("node-fetch");
const FormData = require("form-data");
const Bottleneck = require("bottleneck");

const ALERT_URL =
  "https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjYwNTZhMDYzMTA0M2Q1MjY5NTUzNjUxMzUi_pc";

const RINGCENTRAL_TOKEN_URL =
  "https://platform.ringcentral.com/restapi/oauth/token";

const smsLimiter = new Bottleneck({ maxConcurrent: 1, minTime: 1875 });

let tokenData = null;
let refreshTimeout = null;
let isRefreshing = false;
let refreshPromise = null;

/* -------------------- Utils -------------------- */

function normalizeNumber(num) {
  if (!num) return null;
  const cleaned = num.toString().replace(/\D/g, "");
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

async function logTemp(db, payload) {
  try {
    await db.query(
      "INSERT INTO ringcentral_temp (data) VALUES (?)",
      [JSON.stringify(payload)]
    );
  } catch (err) {
    console.error("Failed to log ringcentral_temp:", err.message);
  }
}

/* -------------------- DB Helpers -------------------- */

async function getSetting(db, key) {
  const [rows] = await db.query(
    "SELECT value FROM app_settings WHERE `key` = ?",
    [key]
  );
  return rows.length ? rows[0].value : null;
}

async function setSetting(db, key, value) {
  await db.query(
    "REPLACE INTO app_settings (`key`, `value`) VALUES (?, ?)",
    [key, value]
  );
}

/* -------------------- TOKEN PERSISTENCE -------------------- */

async function saveToken(db) {
  if (!tokenData) return;
  await setSetting(db, "rc_token", JSON.stringify(tokenData));
}

/* -------------------- TOKEN REFRESH -------------------- */

async function refreshAccessToken(db) {
  if (!tokenData?.refresh_token) return;
  if (isRefreshing) return refreshPromise;

  isRefreshing = true;

  refreshPromise = (async () => {
    try {
      const refreshIssuedAt =
        tokenData.refresh_issued_at ??
        tokenData.issued_at ??
        Date.now();

      const refreshExpiry =
        refreshIssuedAt +
        (tokenData.refresh_token_expires_in || 0) * 1000;

      if (Date.now() >= refreshExpiry) {
        sendAlert(
          "refresh_token_expired",
          "Refresh token expired; reauthorization required",
          { refreshIssuedAt, refreshExpiry }
        );
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

      await logTemp(db, {
        type: "refresh",
        http_status: res.status,
        response: json,
        timestamp: new Date().toISOString(),
      });

      if (!res.ok) throw new Error(JSON.stringify(json));

      tokenData = {
        ...json,
        access_issued_at: Date.now(),
        refresh_issued_at: Date.now(),
      };

      await saveToken(db);
      scheduleRefresh(db);
    } catch (err) {
      console.error("Token refresh failed:", err.message);
      sendAlert("token_refresh_failed", err.message);
    } finally {
      isRefreshing = false;
    }
  })();

  return refreshPromise;
}

function scheduleRefresh(db) {
  if (!tokenData?.expires_in || !tokenData.access_issued_at) return;
  clearTimeout(refreshTimeout);

  const accessExpiryMs =
    tokenData.access_issued_at + tokenData.expires_in * 1000;

  const remainingMs = accessExpiryMs - Date.now();
  const timeoutMs = Math.max(0, remainingMs - 600 * 1000);

  refreshTimeout = setTimeout(
    () => refreshAccessToken(db),
    timeoutMs
  );
}

/* -------------------- LOAD TOKEN -------------------- */

async function loadToken(db) {
  if (tokenData) return;

  const raw = await getSetting(db, "rc_token");
  if (!raw) return;

  tokenData = JSON.parse(raw);

  const issuedAt =
    tokenData.access_issued_at ??
    tokenData.issued_at ??
    Date.now();

  const expiry =
    issuedAt + (tokenData.expires_in || 0) * 1000;

  if (Date.now() >= expiry) {
    await refreshAccessToken(db);
  } else {
    scheduleRefresh(db);
  }
}

/* -------------------- SEND SMS -------------------- */

const sendSmsThroughLimiter = smsLimiter.wrap(
  async (from, to, message) => {
    const res = await fetch(
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

    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
);

async function sendSms(db, from, to, message) {
  from = normalizeNumber(from);
  to = normalizeNumber(to);

  if (!from || !to || !message) throw new Error("Missing required fields");

  const expiry =
    tokenData.access_issued_at +
    tokenData.expires_in * 1000;

  if (Date.now() >= expiry) {
    await refreshAccessToken(db);
  }

  return sendSmsThroughLimiter(from, to, message);
}

/* -------------------- SEND MMS -------------------- */

const sendMmsThroughLimiter = smsLimiter.wrap(
  async (from, to, text, countryIso, attachmentBuffer, attachmentName, attachmentType) => {
    const form = new FormData();
    form.append("from", from);
    form.append("to", to);
    if (text) form.append("text", text);
    form.append("country", JSON.stringify({ isoCode: countryIso }));
    if (attachmentBuffer) {
      form.append("attachment", attachmentBuffer, {
        filename: attachmentName,
        contentType: attachmentType,
      });
    }
    const res = await fetch(
      "https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/mms",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenData.access_token}`, ...form.getHeaders() },
        body: form,
      }
    );
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
);

async function sendMms(db, from, to, text, countryIso = "US", attachmentBuffer, attachmentName, attachmentType) {
  from = normalizeNumber(from);
  to = normalizeNumber(to);
  if (!from || !to) throw new Error("Missing required fields");
  if (text && text.length > 1000) throw new Error("Text too long");
  if (attachmentBuffer && attachmentBuffer.length > 1.5 * 1024 * 1024) {
    throw new Error("Attachment too large");
  }

  const expiry = tokenData?.access_issued_at + (tokenData?.expires_in || 0) * 1000;
  if (!tokenData || Date.now() >= expiry) {
    await refreshAccessToken(db);
    if (!tokenData?.access_token) throw new Error("Not authorized");
  }

  return sendMmsThroughLimiter(from, to, text, countryIso, attachmentBuffer, attachmentName, attachmentType);
}

/* -------------------- AUTH CODE EXCHANGE -------------------- */

async function exchangeCodeForToken(db, code) {
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
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.RINGCENTRAL_REDIRECT_URI,
    }),
  });

  const json = await res.json();

  await logTemp(db, {
    type: "authorization_code",
    http_status: res.status,
    response: json,
    timestamp: new Date().toISOString(),
  });

  if (!res.ok) throw new Error(JSON.stringify(json));

  tokenData = {
    ...json,
    access_issued_at: Date.now(),
    refresh_issued_at: Date.now(),
  };

  await saveToken(db);
  scheduleRefresh(db);
}

/* -------------------- EXPORT -------------------- */

module.exports = {
  loadToken,
  sendSms,
  sendMms,
  refreshAccessToken,
  exchangeCodeForToken,
  get tokenData() {
    return tokenData;
  },
};
