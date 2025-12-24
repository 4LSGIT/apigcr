// startup/init.js
const ringcentralService = require("../services/ringcentralService");

module.exports = async function init(db) {
  try {
    await ringcentralService.loadToken(db); // ← call service function
    console.log("RingCentral token loaded from DB.");
  } catch (err) {
    console.error("Failed to load RingCentral token on startup:", err);
  }
};