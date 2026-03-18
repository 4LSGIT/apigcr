/**
 * parseName — shared name parser
 *
 * Splits a full name string into structured parts, handling suffixes
 * (Jr, Sr, I–X) and hyphenated last names.
 *
 * Extracted from routes/functions.js for reuse in routes and services.
 * The route in functions.js can be updated to: const { parseName } = require('../lib/parseName');
 *
 * @param {string} name — full name string, e.g. "John Michael Smith Jr."
 * @returns {object} { firstName, middleName, lastName, lnameOnly, suffix, flname, lastlastname }
 */

const SUFFIXES = ["jr", "sr", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];

function parseName(name) {
  if (!name || typeof name !== "string") {
    return { firstName: "", middleName: "", lastName: "", lnameOnly: "", suffix: "", flname: "", lastlastname: "" };
  }

  const parts = name
    .replace(/,/g, "")
    .replace(/\\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/  /g, " ")
    .trim()
    .split(" ");

  let firstName = parts[0] || "";
  let middleName = "";
  let lastName = "";
  let suffix = "";
  let lnameOnly = "";
  let flname = "";
  let lastlastname = "";

  if (parts.length > 1) {
    if (SUFFIXES.includes(parts[parts.length - 1].toLowerCase().replace(".", "")) && parts.length > 2) {
      lastName = parts[parts.length - 2] + " " + parts[parts.length - 1];
      middleName = parts.slice(1, parts.length - 2).join(" ");
      lnameOnly = parts[parts.length - 2].split("-")[0];
      lastlastname = lastName.split("-").pop();
      suffix = parts[parts.length - 1];
    } else {
      lastName = parts[parts.length - 1];
      middleName = parts.slice(1, parts.length - 1).join(" ");
      lnameOnly = lastName.split("-")[0];
      lastlastname = lastName.split("-").pop();
    }
  }

  flname = firstName + (lnameOnly ? ` ${lnameOnly}` : "");

  return { firstName, middleName, lastName, lnameOnly, suffix, flname, lastlastname };
}

module.exports = { parseName };