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
  try {
    const bucketName = process.env.GCS_BUCKET;
    if (!bucketName) return res.status(500).json({ error: "Bucket not configured" });

    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Missing username or password" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // ---- AUTH CHECK ----
    const sql = `SELECT user_auth FROM users WHERE username = ? AND password = ? LIMIT 1`;
    const [results] = await new Promise((resolve, reject) => {
      req.db.query(sql, [username, password], (err, results) => {
        if (err) return reject(err);
        resolve([results]);
      });
    });

    if (results.length === 0 || !results[0].user_auth?.startsWith("authorized")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ---- UPLOAD TO GCS ----
    const storage = new Storage();
    const bucket = storage.bucket(bucketName);
    const filename = randomFilename(req.file.originalname);
    const file = bucket.file(filename);

    const now = new Date().toISOString();

    await file.save(req.file.buffer, {
      resumable: false,
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

    // Log metadata internally
    console.log(`[UPLOAD] User: ${username}, File: ${req.file.originalname}, Saved as: ${filename}, Size: ${req.file.size} bytes, Time: ${now}`);

    //const publicUrl = `https://storage.googleapis.com/${bucketName}/${filename}`;
    const publicUrl = `https://uploads.4lsg.com/${filename}`;

    return res.json({
      success: true,
      url: publicUrl,
      filename,
      size: req.file.size,
      mime: req.file.mimetype,
      uploadedAt: now,
    });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message || "Unexpected server error" });
  }
});

module.exports = router;
