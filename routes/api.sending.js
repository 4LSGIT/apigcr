/**
 * Sending Form API routes
 * routes/api.sending.js
 *
 * GET  /api/phone-lines          list active phone lines
 * GET  /api/email-from           list email sender addresses
 * POST /api/compose-docs-message assemble doc request message from selections
 *
 * Mount: app.use('/', require('./routes/api.sending'));
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');


// ─── PHONE LINES ───
router.get('/api/phone-lines', jwtOrApiKey, async (req, res) => {
  try {
    const [lines] = await req.db.query(
      `SELECT id, phone_number, display_name, provider
       FROM phone_lines
       WHERE active = 1
       ORDER BY display_name`
    );
    res.json({ status: 'success', lines });
  } catch (err) {
    console.error('GET /api/phone-lines error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch phone lines' });
  }
});


// ─── EMAIL FROM ADDRESSES ───
router.get('/api/email-from', jwtOrApiKey, async (req, res) => {
  try {
    const [emails] = await req.db.query(
      `SELECT id, email, from_name, provider
       FROM email_credentials
       ORDER BY from_name, email`
    );
    res.json({ status: 'success', emails });
  } catch (err) {
    console.error('GET /api/email-from error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch email addresses' });
  }
});


// ─── COMPOSE DOCUMENT REQUEST MESSAGE ───
// Takes the raw checkbox selections and assembles a coherent message.
// Returns { sms, email_text, email_html, checklist_items }
router.post('/api/compose-docs-message', jwtOrApiKey, async (req, res) => {
  try {
    const {
      docs = [],            // array of selected doc strings
      income_from = '',     // month name, e.g. "January"
      spouse_income_from = '',
      tax_federal = [],     // array of year strings: ["2023","2024"]
      tax_state = [],       // array of year strings
      irs_years = [],       // array of year strings
      bank_from = '',       // month name
      banks = [],           // array of bank names
      append_portal = false,
      append_pdf_docs = false,
    } = req.body;

    // Process each doc item, expanding sub-selections
    const items = [];

    for (const doc of docs) {
      if (doc.includes('pay stubs / proof of all income') && !doc.includes("spouse")) {
        items.push(`PDF copies of pay stubs / proof of all income — from ${income_from || '___'} to present`);

      } else if (doc.includes("spouse's pay stubs")) {
        items.push(`PDF copies of your spouse's pay stubs / proof of all income — from ${spouse_income_from || income_from || '___'} to present`);

      } else if (doc.includes('Tax Returns')) {
        const parts = [];
        if (tax_federal.length) parts.push(`Federal tax returns for ${joinYears(tax_federal)}`);
        if (tax_state.length)   parts.push(`State tax returns for ${joinYears(tax_state)}`);
        if (parts.length) items.push(parts.join(' and '));

      } else if (doc.includes('IRS.GOV')) {
        if (irs_years.length) {
          items.push(`PDF copies of documents from IRS.GOV (including "Wage and Income Transcripts", "Tax Return Transcripts", and "Account Transcripts") ${forYears(irs_years)}`);
        }

      } else if (doc.includes('bank statements')) {
        if (banks.length) {
          const bankList = formatList(banks);
          items.push(`PDF copies of bank statements from ${bank_from || '___'} to the present from ${bankList}`);
        }

      } else {
        // Plain item — pass through as-is
        items.push(doc.trim());
      }
    }

    // Append instruction lines
    if (append_portal) {
      items.push('Please send the documents to DOCS@4LSG or use our secure portal');
    }
    if (append_pdf_docs) {
      items.push('Please send the .PDF documents to DOCS@4LSG');
    }

    // Build SMS text
    const bulletList = items.map(item => `• ${item}`).join('\n');
    const smsText = `HOMEWORK ASSIGNMENT\nWe need the following documents:\n\n${bulletList}`;

    // Build email HTML
    const emailHtml = `<h3>Homework Assignment</h3>
<p>We need the following documents:</p>
<ul>
${items.map(item => `  <li>${escapeHtml(item)}</li>`).join('\n')}
</ul>`;

    const emailText = `Homework Assignment\n\nWe need the following documents:\n\n${bulletList}`;

    res.json({
      status: 'success',
      sms: smsText,
      email_text: emailText,
      email_html: emailHtml,
      checklist_items: items,
    });

  } catch (err) {
    console.error('POST /api/compose-docs-message error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to compose message' });
  }
});


// ─── Helpers ───

function joinYears(years) {
  if (years.length === 0) return '';
  if (years.length === 1) return years[0];
  return years.slice(0, -1).join(', ') + ' and ' + years[years.length - 1];
}

function forYears(years) {
  if (years.length === 0) return '';
  if (years.length === 1) return `for the year ${years[0]}`;
  return `for the years ${joinYears(years)}`;
}

function formatList(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(', ') + ' & ' + items[items.length - 1];
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


module.exports = router;