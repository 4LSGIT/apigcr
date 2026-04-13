const express = require("express");
const router = express.Router();
const { Dropbox } = require('dropbox');

const dbx = new Dropbox({
  accessToken: process.env.DROPBOX_TOKEN
});

router.post('/api/public/get-upload-link', async (req, res) => {
  try {
    const { case_id, filename } = req.body;

    if (!case_id || !filename) {
      return res.status(400).json({ error: 'case_id and filename are required' });
    }

    const [rows] = await req.db.query(
      'SELECT case_dropbox FROM cases WHERE case_id = ?',
      [case_id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Case not found' });
    }

    const sharedLink = rows[0].case_dropbox;
    if (!sharedLink) {
      return res.status(400).json({ error: 'No Dropbox folder linked to this case' });
    }

    // Get folder metadata
    const meta = await dbx.sharingGetSharedLinkMetadata({ url: sharedLink });

    if (meta.result['.tag'] !== 'folder') {
      return res.status(400).json({ error: 'Shared link is not a folder' });
    }

    const folderId = meta.result.id;
    const dropboxPath = `${folderId}/Client Uploads/${filename}`;

    const response = await dbx.filesGetTemporaryUploadLink({
      commit_info: {
        path: dropboxPath,
        mode: { ".tag": "add" },
        autorename: true
      },
      duration: 7200   // Increased to 2 hours (better UX)
    });

    res.json({ link: response.result.link });

  } catch (err) {
    console.error('Get upload link error:', err);
    res.status(500).json({ 
      error: 'Failed to create upload link',
      message: err.message 
    });
  }
});

// NEW: Alert us when client finishes uploading
router.post('/api/public/upload-complete', async (req, res) => {
  try {
    const { case_id, files, comment } = req.body;

    if (!case_id || !files || !Array.isArray(files)) {
      return res.status(400).json({ error: 'case_id and files array are required' });
    }

    // Optional: You can save this to database, send email, Slack, etc.
    console.log(`📨 Upload complete notification - Case: ${case_id}`);
    console.log(`Files uploaded:`, files);
    if (comment) console.log(`Client comment: ${comment}`);

    // TODO: Add your notification logic here (email, SMS, database log, etc.)
 /* Usage:
    const emailService = require('./emailService');
    await emailService.sendEmail(db, {
      from: 'automations@4lsg.com',
      to: 'rena@4lsg.com',
      subject: 'Docs uploaded for case',
      text: 'Plain text fallback',
      html: '<p>HTML version</p>',   // optional
      attachments: []                // optional, nodemailer format (smtp only)
    });
 /*
    res.json({ 
      success: true, 
      message: 'Notification received. Thank you!' 
    });

  } catch (err) {
    console.error('Upload complete error:', err);
    res.status(500).json({ error: 'Failed to process notification' });
  }
});

module.exports = router;