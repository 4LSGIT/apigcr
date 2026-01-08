/**
 * RingCentral Routes
 * ------------------------------------------------------
 * - /ringcentral/send-sms : POST/GET
 * - /ringcentral/send-mms : POST (with optional file attachment or URL)
 * - /ringcentral/status   : GET
 * - /ringcentral/authorize & /callback : OAuth
 *
 * Uses:
 * - API key in headers/query
 * - Calls service for SMS, token refresh, etc.
 */

const express = require("express");
const multer = require("multer"); // For file uploads in MMS
const router = express.Router();
const ringcentral = require("../services/ringcentralService");

// Multer setup for MMS file uploads (memory storage, 1.5MB limit per RingCentral docs)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1.5 * 1024 * 1024 },
});

async function checkApiKey(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;
  const cachedKey = process.env.RINGCENTRAL_API_KEY;
  if (key !== cachedKey) return res.status(403).json({ error: "Invalid API Key" });
  next();
}

// -------------------- LOAD TOKEN --------------------
router.use(async (req, res, next) => {
  try {
    if (ringcentral.loadToken) await ringcentral.loadToken(req.db);
  } catch (err) {
    console.error("Token load failed:", err);
    // Do not block the request — allow route to respond anyway
  }
  next();
});
// -------------------- SEND SMS --------------------
router.all("/ringcentral/send-sms", checkApiKey, async (req, res) => {
  try {
    const { from, to, message } = { ...req.query, ...req.body };
    const result = await ringcentral.sendSms(req.db, from, to, message);
    res.json(result);
  } catch (err) {
    console.error("SMS send failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- SEND MMS --------------------
router.post("/ringcentral/send-mms", checkApiKey, upload.single("attachment"), async (req, res) => {
  try {
    const { from, to, text, country = "US", attachment_url, store_attachment = "false" } = req.body;
    const attachment = req.file;
    const store = store_attachment === "true"; // Convert to boolean
    const result = await ringcentral.sendMms(
      req.db,
      from,
      to,
      text,
      country,
      attachment?.buffer,
      attachment?.originalname,
      attachment?.mimetype,
      attachment_url,
      store
    );
    res.json(result);
  } catch (err) {
    console.error("MMS send failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- STATUS --------------------
router.get("/ringcentral/status", checkApiKey, (req, res) => {
  const token = ringcentral.tokenData;
  res.json({
    authorized: !!token?.access_token,
    access_token_expires_at: token?.access_issued_at ? new Date(token.access_issued_at + (token.expires_in || 0) * 1000) : null,
    refresh_token_expires_at: token?.refresh_issued_at ? new Date(token.refresh_issued_at + (token.refresh_token_expires_in || 0) * 1000) : null
  });
});

// -------------------- OAUTH --------------------
router.get("/ringcentral/authorize", (req, res) => {
  const authUrl = `https://platform.ringcentral.com/restapi/oauth/authorize?response_type=code&client_id=${process.env.RINGCENTRAL_CLIENT_ID}&redirect_uri=${process.env.RINGCENTRAL_REDIRECT_URI}`;
  res.redirect(authUrl);
});

router.get("/ringcentral/callback", async (req, res) => {
  if (req.query.error) return res.status(400).send("Authorization failed: " + req.query.error);

  const code = req.query.code;
  try {
    await ringcentral.exchangeCodeForToken(req.db, code);
    res.send("Authorization successful.");
  } catch (err) {
    console.error("OAuth callback failed:", err);
    res.status(500).send("Failed to retrieve token.");
  }
});

module.exports = router;