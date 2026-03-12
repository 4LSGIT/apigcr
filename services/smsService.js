/**
 * SMS Service — provider router
 *
 * Looks up the from number in phone_lines to determine which
 * provider handles it, then delegates to the correct service.
 *
 * Usage:
 *   const smsService = require('./smsService');
 *   await smsService.sendSms(db, '2485559999', '3135551234', 'Hello!');
 *
 * phone_lines table:
 *   phone_number   char(10)     — 10-digit, no formatting
 *   provider       enum         — 'ringcentral' | 'quo'
 *   provider_id    varchar(50)  — Quo: PN... id; RC: null
 *   active         tinyint(1)
 */

const ringcentral = require("./ringcentralService");
const quo = require("./quoService");

/**
 * Send an SMS from a known internal number.
 * @param {object} db
 * @param {string} from - 10-digit number matching phone_lines.phone_number
 * @param {string} to   - recipient number (any common format)
 * @param {string} message
 */
async function sendSms(db, from, to, message) {
  // Strip formatting to match phone_lines storage format
  const fromClean = from.toString().replace(/\D/g, "").slice(-10);

  const [[line]] = await db.query(
    `SELECT provider, provider_id, active 
     FROM phone_lines 
     WHERE phone_number = ? 
     LIMIT 1`,
    [fromClean]
  );

  if (!line) {
    throw new Error(`No phone line found for number: ${from}`);
  }

  if (!line.active) {
    throw new Error(`Phone line ${from} is inactive`);
  }

  switch (line.provider) {
    case "ringcentral":
      return ringcentral.sendSms(db, fromClean, to, message);

    case "quo":
      if (!line.provider_id) {
        throw new Error(`Quo line ${from} is missing provider_id (PN...)`);
      }
      return quo.sendSms(db, line.provider_id, to, message);

    default:
      throw new Error(`Unknown provider '${line.provider}' for number ${from}`);
  }
}

module.exports = { sendSms };