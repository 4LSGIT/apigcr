/**
 * Campaign Service
 * ------------------------------------------------------
 * Handles:
 * - Sending email campaigns via SMTP
 * - Sending SMS campaigns via RingCentral
 * - Placeholder resolution (body + subject)
 * - Logging results
 * - Rate limiting (emails)
 */

const nodemailer = require("nodemailer");
const unplacehold = require("../lib/unplacehold");
const { sendSms } = require("./ringcentralService");
const { buildMeta } = require("../lib/logMeta");

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendWithRetry(fn, retries = 2) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      const result = await fn();
      return { result, attempt: attempt + 1 };
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt > retries) break;
      await sleep(500 * attempt);
    }
  }
  lastErr.attempts = attempt;
  throw lastErr;
}

function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')       // convert <br> to newlines
    .replace(/<\/p>/gi, '\n\n')          // paragraphs to double line breaks
    .replace(/<\/li>/gi, '\n')           // list items to newlines
    .replace(/<ul>|<ol>|<\/ul>|<\/ol>/gi, '') // remove list wrappers
    .replace(/<[^>]+>/g, '')             // remove remaining tags
    .replace(/\s+\n/g, '\n')             // clean up whitespace before line breaks
    .replace(/\n{3,}/g, '\n\n')          // collapse multiple empty lines
    .trim();
}


function fail(stage, code, err) {
  const e = new Error(err?.message || code);
  e.stage = stage;
  e.code = code;
  e.raw = err;
  return e;
}

async function sendCampaign(db, campaign_id) {
  const [[campaign]] = await db.query(
    "SELECT * FROM campaigns WHERE campaign_id=?",
    [campaign_id]
  );
  if (!campaign) throw new Error("Campaign not found");

  const contactIds = campaign.contact_ids
    .split(",")
    .map(id => parseInt(id.trim()))
    .filter(Boolean);

  let failures = 0;

  let transporter = null;
  if (campaign.type === "email" || campaign.type === "html-email") {
    const [[smtp]] = await db.query(
      "SELECT * FROM email_credentials WHERE email=?",
      [campaign.sender]
    );
    if (!smtp) throw new Error("No SMTP credentials for sender");

    transporter = nodemailer.createTransport({
      host: smtp.smtp_host,
      port: smtp.smtp_port,
      secure: !!smtp.smtp_secure,
      auth: { user: smtp.smtp_user, pass: smtp.smtp_pass },
      logger: true,//temp
      debug: true//temp
    });
  }

  for (const contact_id of contactIds) {
    try {
      const bodyResult = await unplacehold({ db, text: campaign.body, contact_id, strict: true });
      const subjectResult = await unplacehold({ db, text: campaign.subject, contact_id, strict: true });

      if (bodyResult.status === "failed" || subjectResult.status === "failed") {
        throw fail("resolve", "PLACEHOLDER_FAIL");
      }

      if (campaign.type === "email" || campaign.type === "html-email") {
        const [[contact]] = await db.query(
          "SELECT contact_email FROM contacts WHERE contact_id=?",
          [contact_id]
        );
        if (!contact?.contact_email) throw fail("lookup", "NO_CONTACT_EMAIL");

        const sendResult = await sendWithRetry(() =>
          transporter.sendMail({
            from: campaign.sender,
            to: contact.contact_email,
            subject: subjectResult.text,
            text: htmlToPlainText(bodyResult.text),
            html: bodyResult.text
          })
        );

        await db.query(
          `INSERT INTO campaign_results
           (campaign_id, contact_id, status, result_meta)
           VALUES (?,?,?,?)`,
          [
            campaign_id,
            contact_id,
            "sent",
            JSON.stringify(
              buildMeta({
                stage: "send",
                code: "OK",
                attempts: sendResult.attempt,
                provider: "smtp",
                providerMessageId: sendResult.result?.messageId
              })
            )
          ]
        );

        await sleep(500);

      } else if (campaign.type === "sms") {
        const [[contact]] = await db.query(
          "SELECT contact_phone FROM contacts WHERE contact_id=?",
          [contact_id]
        );
        if (!contact?.contact_phone) throw fail("lookup", "NO_CONTACT_PHONE");

        const smsResult = await sendSms(db, campaign.sender, contact.contact_phone, bodyResult.text);

        await db.query(
          `INSERT INTO campaign_results
           (campaign_id, contact_id, status, result_meta)
           VALUES (?,?,?,?)`,
          [
            campaign_id,
            contact_id,
            "sent",
            JSON.stringify(
              buildMeta({
                stage: "send",
                code: "OK",
                attempts: 1,
                provider: "ringcentral",
                providerMessageId: smsResult?.messageId
              })
            )
          ]
        );
      }

    } catch (err) {
      failures++;
      await db.query(
        `INSERT INTO campaign_results
         (campaign_id, contact_id, status, error, result_meta)
         VALUES (?,?,?,?,?)`,
        [
          campaign_id,
          contact_id,
          "failed",
          err.message,
          JSON.stringify(
            buildMeta({
              stage: err.stage || "unknown",
              code: err.code || "UNCLASSIFIED",
              attempts: err.attempts || 1,
              provider: campaign.type === "sms" ? "ringcentral" : "smtp",
              retryable: err.code?.startsWith("SMTP")
            })
          )
        ]
      );
    }
  }

  return { total: contactIds.length, failures };
}

module.exports = { sendCampaign };

