const { loadTokenFromDb } = require("../routes/ringcentral");
module.exports = function(db) {
  loadTokenFromDb(db);
  console.log("RingCentral token loader started.");
};
