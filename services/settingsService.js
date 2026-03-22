/**
 * Settings Service
 * services/settingsService.js
 *
 * Reads from the app_settings key/value table.
 * Extracted here so every service can require() it
 * instead of duplicating the query.
 *
 * Usage:
 *   const { getSetting } = require('../services/settingsService');
 *   const from = await getSetting(db, 'sms_default_from');
 */

/**
 * Fetch a single value from app_settings by key.
 * @param {object} db  - mysql2 pool (req.db or passed from service)
 * @param {string} key - the setting key
 * @returns {string|null} the value, or null if not found
 */
async function getSetting(db, key) {
  const [[row]] = await db.query(
    "SELECT `value` FROM app_settings WHERE `key` = ? LIMIT 1",
    [key]
  );
  return row?.value ?? null;
}

/**
 * Fetch multiple settings in one query.
 * @param {object} db   - mysql2 pool
 * @param {string[]} keys - array of setting keys
 * @returns {object} { key: value, ... } — missing keys are null
 */
async function getSettings(db, keys) {
  if (!keys.length) return {};
  const [rows] = await db.query(
    "SELECT `key`, `value` FROM app_settings WHERE `key` IN (?)",
    [keys]
  );
  const result = {};
  for (const k of keys) result[k] = null;
  for (const row of rows) result[row.key] = row.value;
  return result;
}

module.exports = { getSetting, getSettings };