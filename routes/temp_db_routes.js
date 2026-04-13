const express = require("express");
const router = express.Router();
const { Dropbox } = require('dropbox');

const dbx = new Dropbox({
  accessToken: process.env.DROPBOX_TOKEN
});

router.post('/api/public/get-upload-link', async (req, res) => {
  try {
    const { case_id, filename } = req.body;

    const [rows] = await req.db.query(
      'SELECT case_dropbox FROM cases WHERE case_id = ?',
      [case_id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Case not found' });
    }

    const sharedLink = rows[0].case_dropbox;

    // 🔥 1. Resolve shared link → metadata
    const meta = await dbx.sharingGetSharedLinkMetadata({
      url: sharedLink
    });

    if (meta.result['.tag'] !== 'folder') {
      return res.status(400).json({ error: 'Not a folder link' });
    }

    const folderId = meta.result.id; // <-- THIS is key

    // 🔥 2. Build path using ID
    const dropboxPath = `${folderId}/client_uploads/${filename}`;

    // 🔥 3. Create temp upload link
    const response = await dbx.filesGetTemporaryUploadLink({
      commit_info: {
        path: dropboxPath,
        mode: { ".tag": "add" },
        autorename: true
      },
      duration: 3600
    });

    res.json({
      link: response.result.link
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create upload link' });
  }
});

module.exports = router;