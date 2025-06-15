const express = require("express");
const router = express.Router();
const path = require("path");

router.get('/api', (req, res) => {
  res.send('Where does the 4LSG API lives? here');
});


router.get('/appt', (req, res) => {
  res.sendFile(path.join(__dirname, "..", 'public', 'appt.html'));
});

router.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, "..", 'public', 'docs.html'));
});

router.get("/newpath", (req, res) => {
  res.json({ message: "This is the new path!" });
});

module.exports = router;