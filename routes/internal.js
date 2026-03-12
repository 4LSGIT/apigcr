// routes/internal.js
const express = require("express");
const router = express.Router();

router.use(require("./internal/sms"));
router.use(require("./internal/email"));
router.use(require("./internal/gcal"));
router.use(require("./internal/sequence"));

module.exports = router;