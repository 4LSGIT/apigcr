// routes/internal.js
const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const routesPath = path.join(__dirname, "internal");

// Read all files in /routes/internal
fs.readdirSync(routesPath)
  .filter(file => file.endsWith(".js"))
  .forEach(file => {
    const route = require(path.join(routesPath, file));
    router.use(route);
  });

module.exports = router;