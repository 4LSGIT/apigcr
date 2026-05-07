//services/drivers/phone/index.js
/**
 * Phone Driver Registry
 *
 * Holds the in-process registry of phone drivers (SMS, MMS, future
 * channels). Bad-shape drivers throw at register() time, which is
 * called at module load — so a misconfigured driver crashes the app
 * at boot, not first send.
 *
 * Public API:
 *   register(driver)    — validate + register; throws on bad shape or
 *                         duplicate id.
 *   get(id)             — returns the driver or null.
 *   list()              — returns an array of all registered drivers.
 *   validateDriver(d)   — exposed for tests; throws on bad shape.
 *
 * See ./\_interface.md for the full driver contract.
 */

const drivers = new Map();

/**
 * Validate a driver's shape. Throws on the first violation.
 * @param {object} d - driver module export
 */
function validateDriver(d) {
  if (!d || typeof d !== 'object') {
    throw new Error('Driver must be an object');
  }

  if (typeof d.id !== 'string' || d.id.length === 0) {
    throw new Error('Driver.id must be a non-empty string');
  }

  if (typeof d.displayName !== 'string' || d.displayName.length === 0) {
    throw new Error(`Driver "${d.id}".displayName must be a non-empty string`);
  }

  if (!Array.isArray(d.credentialTypeWhitelist) || d.credentialTypeWhitelist.length === 0) {
    throw new Error(`Driver "${d.id}".credentialTypeWhitelist must be a non-empty array`);
  }

  const sendMethods = Object.keys(d).filter(
    k => typeof d[k] === 'function' && k.startsWith('send')
  );
  if (sendMethods.length === 0) {
    throw new Error(
      `Driver "${d.id}" must expose at least one send<Channel> method ` +
      `(e.g. sendSms, sendMms)`
    );
  }
}

/**
 * Register a driver. Validates shape and uniqueness.
 * @param {object} driver
 */
function register(driver) {
  validateDriver(driver);
  if (drivers.has(driver.id)) {
    throw new Error(`Driver "${driver.id}" is already registered`);
  }
  drivers.set(driver.id, driver);
}

/**
 * Look up a driver by id.
 * @param {string} id
 * @returns {object|null}
 */
function get(id) {
  return drivers.get(id) || null;
}

/**
 * List all registered drivers.
 * @returns {object[]}
 */
function list() {
  return Array.from(drivers.values());
}

module.exports = { register, get, list, validateDriver };

// ─────────────────────────────────────────────────────────────────────────
// Boot-time auto-registration.
//
// Slice 1: only the fake driver. Real drivers (./quo, ./ringcentral) land
// in slices 2 and 3 and will be added here at that time.
//
// register() throws synchronously on bad shape — by design — so a
// misconfigured driver crashes the app at boot rather than first send.
// ─────────────────────────────────────────────────────────────────────────
register(require('./_test_fake'));