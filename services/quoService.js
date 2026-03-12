/**
 * Quo (formerly OpenPhone) SMS Service
 * API: https://api.openphone.com/v1
 * Auth: API key in Authorization header
 * From: must be phoneNumberId (PN...) not the actual phone number
 */

const QUO_API_URL = "https://api.openphone.com/v1/messages";

async function getApiKey(db) {
  const [[row]] = await db.query(
    "SELECT value FROM app_settings WHERE `key` = 'quo_api_key'"
  );
  if (!row?.value) throw new Error("Quo API key not found in app_settings");
  return row.value;
}

function normalizeNumber(num) {
  if (!num) return null;
  const cleaned = num.toString().replace(/\D/g, "");
  if (cleaned.length === 11 && cleaned.startsWith("1")) return `+${cleaned}`;
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (num.toString().startsWith("+")) return num.toString();
  return null;
}

/**
 * Send SMS via Quo
 * @param {object} db
 * @param {string} fromPhoneNumberId - Quo PN... id from phone_lines.provider_id
 * @param {string} to - recipient phone number (any format, will normalize)
 * @param {string} message - text content (max 1600 chars)
 */
async function sendSms(db, fromPhoneNumberId, to, message) {
  if (!fromPhoneNumberId) throw new Error("Missing Quo phoneNumberId");
  if (!message?.trim()) throw new Error("Missing message content");

  const toNormalized = normalizeNumber(to);
  if (!toNormalized) throw new Error(`Invalid to number: ${to}`);

  const apiKey = await getApiKey(db);

  const payload = {
    content: message,
    from: fromPhoneNumberId,
    to: [toNormalized],
    setInboxStatus: "done"
  };

  let result;
  try {
    const res = await fetch(QUO_API_URL, {
      method: "POST",
      headers: {
        "Authorization": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    result = await res.json();

    if (!res.ok) {
      throw new Error(`Quo API error ${res.status}: ${JSON.stringify(result)}`);
    }
  } catch (err) {
    // Log failure asynchronously — don't block throw
    db.query(
      `INSERT INTO rc_messages_log 
       (type, from_number, to_number, message, status, error_message) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["sms", fromPhoneNumberId, toNormalized, message, "error", err.message]
    ).catch(e => console.error("Failed to log Quo SMS error:", e));

    throw err;
  }

  // Log success asynchronously
  db.query(
    `INSERT INTO rc_messages_log 
     (type, from_number, to_number, message, status, rc_response) 
     VALUES (?, ?, ?, ?, ?, ?)`,
    ["sms", fromPhoneNumberId, toNormalized, message, "success", JSON.stringify(result)]
  ).catch(e => console.error("Failed to log Quo SMS:", e));

  return result.data;
}

module.exports = { sendSms };