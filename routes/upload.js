const express = require("express");
const { Storage } = require("@google-cloud/storage");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

const router = express.Router();

// Max upload size: 25 MB
const MAX_FILE_SIZE = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

// Helper: generate random filename
function randomFilename(originalName) {
  const ext = path.extname(originalName);
  const random = crypto.randomBytes(16).toString("hex");
  return `${random}${ext}`;
}

router.post("/upload", upload.single("file"), async (req, res) => {
  const requestStartTime = Date.now();
  console.log(`[UPLOAD START] ${new Date().toISOString()} - Request received from IP: ${req.ip}`);

  try {
    // Log basic request info
    console.log(`[UPLOAD INFO] File field present: ${!!req.file}`);
    console.log(`[UPLOAD INFO] Body fields: username=${req.body.username ? 'present' : 'missing'}, password=${req.body.password ? 'present' : 'missing'}`);

    const bucketName = process.env.GCS_BUCKET;
    if (!bucketName) {
      console.error("[UPLOAD ERROR] GCS_BUCKET environment variable not set");
      return res.status(500).json({ error: "Bucket not configured" });
    }
    console.log(`[UPLOAD INFO] Using bucket: ${bucketName}`);

    const { username, password } = req.body;
    if (!username || !password) {
      console.warn("[UPLOAD WARN] Missing username or password");
      return res.status(400).json({ error: "Missing username or password" });
    }
    if (!req.file) {
      console.warn("[UPLOAD WARN] No file uploaded");
      return res.status(400).json({ error: "No file uploaded" });
    }

    console.log(`[UPLOAD INFO] File details - Name: ${req.file.originalname}, Size: ${req.file.size} bytes, MIME: ${req.file.mimetype}`);

    // ---- AUTH CHECK ----
    console.log(`[UPLOAD STEP 1] Starting DB authentication query at ${new Date().toISOString()}`);
    const sql = `SELECT user_auth FROM users WHERE username = ? AND password = ? LIMIT 1`;

    let results;
    try {
      [results] = await new Promise((resolve, reject) => {
        const queryStart = Date.now();
        req.db.query(sql, [username, password], (err, queryResults) => {
          const queryDuration = Date.now() - queryStart;
          if (err) {
            console.error(`[UPLOAD DB ERROR] Query failed after ${queryDuration}ms: ${err.message}`);
            return reject(err);
          }
          console.log(`[UPLOAD STEP 1] DB query completed in ${queryDuration}ms`);
          resolve([queryResults]);
        });
      });
    } catch (dbErr) {
      console.error("[UPLOAD DB CRITICAL] DB query promise rejected:", dbErr);
      return res.status(500).json({ error: "Database error" });
    }

    if (results.length === 0 || !results[0].user_auth?.startsWith("authorized")) {
      console.warn("[UPLOAD AUTH FAIL] Unauthorized credentials");
      return res.status(401).json({ error: "Unauthorized" });
    }
    console.log("[UPLOAD STEP 1] Authentication successful");

    // ---- UPLOAD TO GCS ----
    console.log(`[UPLOAD STEP 2] Starting GCS upload at ${new Date().toISOString()}`);
    const storage = new Storage();
    const bucket = storage.bucket(bucketName);
    const filename = randomFilename(req.file.originalname);
    const file = bucket.file(filename);

    const now = new Date().toISOString();

    const uploadStart = Date.now();
    await file.save(req.file.buffer, {
      resumable: true, // Changed to true for better reliability
      timeoutMs: 300000, // 5 min timeout per operation
      metadata: {
        contentType: req.file.mimetype,
        cacheControl: "public, max-age=31536000",
        metadata: {
          username,
          originalName: req.file.originalname,
          uploadedAt: now,
        },
      },
    });
    const uploadDuration = Date.now() - uploadStart;
    console.log(`[UPLOAD STEP 2] GCS upload completed in ${uploadDuration}ms - Filename: ${filename}`);

    // Log success
    const totalDuration = Date.now() - requestStartTime;
    console.log(`[UPLOAD SUCCESS] User: ${username}, File: ${req.file.originalname}, Saved as: ${filename}, Size: ${req.file.size} bytes, Total time: ${totalDuration}ms`);

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${filename}`;

    return res.json({
      success: true,
      url: publicUrl,
      filename,
      size: req.file.size,
      mime: req.file.mimetype,
      uploadedAt: now,
    });

  } catch (err) {
    const totalDuration = Date.now() - requestStartTime;
    console.error(`[UPLOAD CRITICAL ERROR] after ${totalDuration}ms:`, err);
    res.status(500).json({ error: err.message || "Unexpected server error" });
  } finally {
    console.log(`[UPLOAD END] Request completed or failed - Total time: ${Date.now() - requestStartTime}ms`);
  }
});

module.exports = router;
