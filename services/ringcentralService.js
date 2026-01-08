/**
 * RingCentral Service (clean, no logging)
 */

const fetch = require("node-fetch");
const FormData = require("form-data"); // For MMS multipart
const Bottleneck = require("bottleneck");
const path = require("path");
const crypto = require("crypto");
const { Storage } = require("@google-cloud/storage"); // For internal GCS upload

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
          "Refresh token expired; reauthorization required"
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

  try {
    const result = await sendSmsThroughLimiter(from, to, message);
    // Log to DB asynchronously
    db.query(
      "INSERT INTO rc_messages_log (type, from_number, to_number, message, status, rc_response) VALUES (?, ?, ?, ?, ?, ?)",
      ["sms", from, to, message, "success", JSON.stringify(result)],
      (err) => {
        if (err) console.error("Failed to log SMS:", err);
      }
    );
    return result;
  } catch (err) {
    // Log error to DB asynchronously
    db.query(
      "INSERT INTO rc_messages_log (type, from_number, to_number, message, status, error_message) VALUES (?, ?, ?, ?, ?, ?)",
      ["sms", from, to, message, "error", err.message],
      (errLog) => {
        if (errLog) console.error("Failed to log SMS error:", errLog);
      }
    );
    throw err;
  }
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

// Helper: generate random filename (from upload.js)
function randomFilename(originalName) {
  const ext = path.extname(originalName);
  const random = crypto.randomBytes(16).toString("hex");
  return `${random}${ext}`;
}

// Helper: Internal upload to GCS (duplicated logic from /upload, but skips auth for internal use)
async function internalUploadToGcs(buffer, originalName, mimeType) {
  const bucketName = process.env.GCS_BUCKET;
  if (!bucketName) {
    throw new Error("Bucket not configured");
  }
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);
  const filename = randomFilename(originalName);
  const file = bucket.file(filename);
  const now = new Date().toISOString();
  await file.save(buffer, {
    resumable: true,
    timeoutMs: 300000,
    metadata: {
      contentType: mimeType,
      cacheControl: "public, max-age=31536000",
      metadata: {
        username: "system", // Fixed for internal
        originalName,
        uploadedAt: now,
      },
    },
  });
  const publicUrl = `https://storage.googleapis.com/${bucketName}/${filename}`;
  return { url: publicUrl, filename };
}

async function sendMms(db, from, to, text, countryIso = "US", attachmentBuffer, attachmentName, attachmentType, attachmentUrl, storeAttachment = false) {
  from = normalizeNumber(from);
  to = normalizeNumber(to);
  if (!from || !to) throw new Error("Missing required fields");
  if (attachmentBuffer && attachmentUrl) {
  throw new Error("Provide either attachment file or URL, not both");
}
  if (text && text.length > 1000) throw new Error("Text too long");

  let finalBuffer = attachmentBuffer;
  let finalName = attachmentName || "attachment";
  let finalType = attachmentType || "application/octet-stream";
  let storedUrl = null;
  let storedFilename = null;

  // If URL provided and no file, fetch the attachment
  if (attachmentUrl && !attachmentBuffer) {
    const res = await fetch(attachmentUrl);
    if (!res.ok) throw new Error(`Failed to fetch attachment: ${res.statusText}`);
    finalBuffer = Buffer.from(await res.arrayBuffer());
    finalType = res.headers.get("content-type") || finalType;
    finalName = path.basename(attachmentUrl) || finalName; // Infer name from URL
    if (finalBuffer.length > 1.5 * 1024 * 1024) {
      throw new Error("Attachment too large");
    }
  }

  // If storeAttachment and we have a buffer (from file or URL), upload to GCS
  if (storeAttachment && finalBuffer) {
    const { url, filename } = await internalUploadToGcs(finalBuffer, finalName, finalType);
    storedUrl = url;
    storedFilename = filename;
  }

  const expiry = tokenData?.access_issued_at + (tokenData?.expires_in || 0) * 1000;
  if (!tokenData || Date.now() >= expiry) {
    await refreshAccessToken(db);
    if (!tokenData?.access_token) throw new Error("Not authorized");
  }

  try {
    const result = await sendMmsThroughLimiter(from, to, text, countryIso, finalBuffer, finalName, finalType);
    // Log to DB asynchronously
    db.query(
      "INSERT INTO rc_messages_log (type, from_number, to_number, message, attachment_filename, attachment_url, status, rc_response) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["mms", from, to, text || null, storedFilename || finalName, storedUrl || attachmentUrl || null, "success", JSON.stringify(result)],
      (err) => {
        if (err) console.error("Failed to log MMS:", err);
      }
    );
    return result;
  } catch (err) {
    // Log error to DB asynchronously
    db.query(
      "INSERT INTO rc_messages_log (type, from_number, to_number, message, attachment_filename, attachment_url, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["mms", from, to, text || null, storedFilename || finalName, storedUrl || attachmentUrl || null, "error", err.message],
      (errLog) => {
        if (errLog) console.error("Failed to log MMS error:", errLog);
      }
    );
    throw err;
  }
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