const express = require("express");
const { Storage } = require("@google-cloud/storage");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

const router = express.Router();

/**
 * ---- CONFIG ----
 */

// Max upload size: 25 MB (good balance for images, audio, PDFs, etc.)
const MAX_FILE_SIZE = 25 * 1024 * 1024;

// Multer in-memory storage (Cloud Run safe)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
});

// Google Cloud Storage
const storage = new Storage();
const bucketName = process.env.GCS_BUCKET;
const bucket = storage.bucket(bucketName);

/**
 * ---- HELPERS ----
 */

function randomFilename(originalName) {
  const ext = path.extname(originalName);
  const random = crypto.randomBytes(16).toString("hex");
  return `${random}${ext}`;
}

/**
 * ---- ROUTE ----
 *
 * POST /upload
 *
 * Form-data:
 * - file (binary)
 * - username
 * - password
 */
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Missing username or password" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // ---- AUTH CHECK ----
    const sql = `
      SELECT user_auth
      FROM users
      WHERE username = ? AND password = ?
      LIMIT 1
    `;

    req.db.query(sql, [username, password], async (err, results) => {
      if (err) {
        console.error("DB error:", err);
        return res.status(500).json({ error: "Database error" });
      }

      if (
        results.length === 0 ||
        !results[0].user_auth ||
        !results[0].user_auth.startsWith("authorized")
      ) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // ---- UPLOAD TO GCS ----
      const filename = randomFilename(req.file.originalname);
      const file = bucket.file(filename);

      const stream = file.createWriteStream({
        resumable: false,
        metadata: {
          contentType: req.file.mimetype,
          cacheControl: "public, max-age=31536000",
        },
      });

      stream.on("error", (err) => {
        console.error("Upload error:", err);
        return res.status(500).json({ error: "Upload failed" });
      });

      stream.on("finish", async () => {
        // Make public
        await file.makePublic();

        const publicUrl = `https://storage.googleapis.com/${bucketName}/${filename}`;

        return res.json({
          success: true,
          url: publicUrl,
          filename,
          size: req.file.size,
          mime: req.file.mimetype,
        });
      });

      stream.end(req.file.buffer);
    });
  } catch (err) {
    console.error("Unexpected error:", err);
    res.status(500).json({ error: "Unexpected server error" });
  }
});

module.exports = router;
