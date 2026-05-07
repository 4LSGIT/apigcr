//services/phoneDriverDispatcher.js
/**
 * Phone Driver Dispatcher
 *
 * Resolves a phone driver from a from-number (via phone_lines) and
 * dispatches a channel operation (sendSms, sendMms, ...) to it.
 *
 * Slice 1: reachable only from the parallel v2 routes
 * (/internal/sms/v2/send, /internal/mms/v2/send). The legacy v1 path
 * (smsService → ringcentralService/quoService, /internal/sms/send,
 * /internal/mms/send) is unchanged.
 *
 * Slice 5 (deferred) will route the existing services through here too.
 *
 * Public exports — signatures are load-bearing for slice 5; do not add
 * internal-only positional args:
 *   sendSms(db, from, opts)
 *   sendMms(db, from, opts)
 */

const registry = require('./drivers/phone');

/**
 * Resolve the driver and phone_lines row for a given from-number.
 * Internal — not exported.
 *
 * Error messages match exit criteria 5 & 6 of the slice 1 spec exactly;
 * do not change wording without coordinating with the test harness.
 *
 * @param {object} db
 * @param {string} fromPhone - any common format; normalised to 10 digits
 * @returns {Promise<{driver: object, line: object, credentialId: number|null}>}
 */
async function resolveDriverForLine(db, fromPhone) {
  const fromClean = String(fromPhone).replace(/\D/g, '').slice(-10);

  const [rows] = await db.query(
    `SELECT id, phone_number, driver_key, credential_id, driver_config,
            mms_capable, active
       FROM phone_lines
      WHERE phone_number = ?
      LIMIT 1`,
    [fromClean]
  );
  const line = rows && rows[0];

  if (!line)            throw new Error(`No phone line for ${fromPhone}`);
  if (!line.active)     throw new Error(`Phone line ${fromPhone} is inactive`);
  if (!line.driver_key) throw new Error(`Phone line ${fromPhone} has no driver_key (legacy v1 line)`);

  const driver = registry.get(line.driver_key);
  if (!driver) throw new Error(`Unknown driver_key: ${line.driver_key}`);

  return { driver, line, credentialId: line.credential_id };
}

/**
 * Dispatch a channel op to the resolved driver. Internal — not exported.
 *
 * Per cookbook §5.13: mysql2 returns JSON columns as either string or
 * object depending on client/version. Defensive parse below.
 *
 * @param {object} db
 * @param {string} fromPhone
 * @param {string} op - 'sendSms' | 'sendMms' | future 'sendWhatsApp' etc.
 * @param {object} opts - channel-specific payload
 */
async function dispatchPhoneOp(db, fromPhone, op, opts) {
  const { driver, line, credentialId } = await resolveDriverForLine(db, fromPhone);

  if (typeof driver[op] !== 'function') {
    throw new Error(`Driver ${driver.id} does not implement ${op}`);
  }

  // MMS-specific line-level capability gate. mms_capable is
  // NOT NULL DEFAULT 0 in the schema, so the design doc's "NULL = use
  // driver default" branch is unreachable — collapse to a strict ===1
  // check.
  if (op === 'sendMms' && line.mms_capable !== 1) {
    throw new Error(
      `Phone line ${line.phone_number} is not MMS-capable ` +
      `(driver=${driver.id}, line.mms_capable=${line.mms_capable})`
    );
  }

  // Defensive JSON parse — see cookbook §5.13.
  let driverConfig = line.driver_config;
  if (typeof driverConfig === 'string') {
    try {
      driverConfig = JSON.parse(driverConfig);
    } catch (err) {
      throw new Error(
        `Phone line ${line.phone_number} has invalid driver_config JSON: ${err.message}`
      );
    }
  }

  const ctx = {
    db,
    credentialId,
    driverConfig,
    fromPhone:   line.phone_number,
    fromLineRow: line,
  };

  return driver[op](ctx, opts);
}

exports.sendSms = (db, from, opts) => dispatchPhoneOp(db, from, 'sendSms', opts);
exports.sendMms = (db, from, opts) => dispatchPhoneOp(db, from, 'sendMms', opts);