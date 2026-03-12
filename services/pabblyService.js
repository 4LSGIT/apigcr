/**
 * Pabbly Service — generic fire-and-forget dispatcher
 *
 * Sends a { service, data } payload to the pabbly_internal_url webhook.
 * Non-blocking — errors are logged but never thrown.
 *
 * Usage:
 *   const pabbly = require('./pabblyService');
 *   pabbly.send(db, 'gcal_delete', { appt_gcal: 'xyz', appt_id: 123 });
 *   pabbly.send(db, 'gcal_create', { appt_id, appt_date, ... });
 *   pabbly.send(db, 'sequence_enroll', { contact_id, sequence_type, ... });
 *   pabbly.send(db, 'email_gmail', { from, to, subject, text, html });
 *
 * All sends are fire-and-forget. This function always returns immediately.
 * Pabbly slowness never blocks the caller.
 */

async function send(db, service, data) {
  try {
    const [[row]] = await db.query(
      "SELECT value FROM app_settings WHERE `key` = 'pabbly_internal_url' LIMIT 1"
    );

    if (!row?.value) {
      console.error(`pabblyService.send: app_settings missing key 'pabbly_internal_url' (service: ${service})`);
      return;
    }

    fetch(row.value, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service, data })
    }).catch(err => console.error(`Pabbly call failed [${service}]:`, err.message));

  } catch (err) {
    console.error(`pabblyService.send error [${service}]:`, err.message);
  }
}

module.exports = { send };