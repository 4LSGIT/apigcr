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
    if (!bucketName) {
      return res.status(500).json({ error: "Bucket not configured" });
    }

    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Missing username or password" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // ---- AUTH CHECK (using mysql2 promise interface) ----
    const sql = `SELECT user_auth FROM users WHERE username = ? AND password = ? LIMIT 1`;
    const [results] = await req.db.query(sql, [username, password]);

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
      resumable: true,              // Better reliability on slow networks
      timeoutMs: 300000,            // 5 min timeout per operation
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
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message || "Unexpected server error" });
  }
});

module.exports = router;
