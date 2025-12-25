const express = require("express");
const { Storage } = require("@google-cloud/storage");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

const router = express.Router();

/* ---------------- CONFIG ---------------- */

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

/* ---------------- HELPERS ---------------- */

function randomFilename(originalName) {
  const ext = path.extname(originalName);
  const rand = crypto.randomBytes(16).toString("hex");
  return `${rand}${ext}`;
}

function queryAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, results) => {
      if (err) return reject(err);
      resolve(results);
    });
  });
}

/* ---------------- ROUTE ---------------- */

router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    /* ---------- ENV ---------- */
    const bucketName = process.env.GCS_BUCKET;
    if (!bucketName) {
      return res.status(500).json({ error: "GCS_BUCKET not configured" });
    }

    /* ---------- INPUT ---------- */
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Missing username or password" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    /* ---------- AUTH ---------- */
    const authSql =
      "SELECT user_auth FROM users WHERE username = ? AND password = ? LIMIT 1";

    const authRows = await queryAsync(req.db, authSql, [
      username,
      password,
    ]);

    if (
      authRows.length === 0 ||
      typeof authRows[0].user_auth !== "string" ||
      !authRows[0].user_auth.startsWith("authorized")
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    /* ---------- GCS UPLOAD ---------- */
    const storage = new Storage();
    const bucket = storage.bucket(bucketName);

    const filename = randomFilename(req.file.originalname);
    const file = bucket.file(filename);

    const uploadedAt = new Date().toISOString();

    await file.save(req.file.buffer, {
      resumable: false,
      contentType: req.file.mimetype,
      metadata: {
        cacheControl: "public, max-age=31536000",
        metadata: {
          username,
          originalName: req.file.originalname,
          uploadedAt,
        },
      },
    });

    const publicUrl = `https://storage.googleapis.com/${bucketName}/${filename}`;

    /* ---------- LOG ---------- */
    console.log(
      `[UPLOAD] user=${username} file=${req.file.originalname} size=${req.file.size} saved_as=${filename}`
    );

    /* ---------- RESPONSE ---------- */
    return res.json({
      success: true,
      url: publicUrl,
      filename,
      size: req.file.size,
      mime: req.file.mimetype,
      uploadedAt,
    });
  } catch (err) {
    console.error("[UPLOAD ERROR]", err);
    return res.status(500).json({
      error: "Upload failed",
      details: err.message,
    });
  }
});

module.exports = router;
