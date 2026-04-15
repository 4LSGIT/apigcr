/**
 * Sending Form API routes
 * routes/api.sending.js
 *
 * GET  /api/phone-lines          list active phone lines
 * GET  /api/email-from           list email sender addresses
 * GET  /api/users/me             current user's defaults
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
       ORDER BY display_name DESC`
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
       ORDER BY id --from_name, email`
    );
    res.json({ status: 'success', emails });
  } catch (err) {
    console.error('GET /api/email-from error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch email addresses' });
  }
});


// ─── CURRENT USER DEFAULTS ───
router.get('/api/users/me', jwtOrApiKey, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const [[user]] = await req.db.query(
      `SELECT user, user_name, email, default_phone, default_email
       FROM users WHERE user = ?`,
      [userId]
    );
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    res.json({ status: 'success', user });
  } catch (err) {
    console.error('GET /api/users/me error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch user' });
  }
});


// ─── COMPOSE DOCUMENT REQUEST MESSAGE ───
// Takes the raw checkbox selections and assembles a coherent message.
// Returns { sms, email_text, email_html, checklist_items }
router.post('/api/compose-docs-message', jwtOrApiKey, async (req, res) => {
  try {
    const {
      docs = [],            // array of { value, extra? } or plain strings
      income_from = '',     // month name, e.g. "January"
      spouse_income_from = '',
      tax_federal = [],     // array of year strings: ["2023","2024"]
      tax_state = [],       // array of year strings
      irs_years = [],       // array of year strings
      bank_from = '',       // month name
      banks = [],           // array of bank names
      property_address = '',// address for property deed
      other_docs_text = '', // free text for "Other Documents"
      send_docs_to = '',    // 'portal' | 'pdf' | '' (none)
      case_id = '',         // for portal link
    } = req.body;

    // Validation warnings (items checked but sub-selection empty)
    const warnings = [];

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
        if (parts.length) {
          items.push(parts.join(' and '));
        } else {
          warnings.push('Tax Returns checked but no years selected');
        }

      } else if (doc.includes('IRS.GOV')) {
        if (irs_years.length) {
          items.push(`PDF copies of documents from IRS.GOV (including "Wage and Income Transcripts", "Tax Return Transcripts", and "Account Transcripts") ${forYears(irs_years)}`);
        } else {
          warnings.push('IRS.GOV checked but no years selected');
        }

      } else if (doc.includes('bank statements')) {
        if (banks.length) {
          const bankList = formatList(banks);
          items.push(`PDF copies of bank statements from ${bank_from || '___'} to the present from ${bankList}`);
        } else {
          warnings.push('Bank statements checked but no banks selected');
        }

      } else if (doc.includes('Property Deed')) {
        items.push(`PDF copy of the deed to your real estate${property_address ? ` at ${property_address}` : ''}`);

      } else if (doc.includes('Other Documents') && other_docs_text) {
        items.push(other_docs_text.trim());

      } else if (doc.includes('Other Documents') && !other_docs_text) {
        warnings.push('Other Documents checked but no description provided');

      } else {
        items.push(doc.trim());
      }
    }

    // Build portal link
    const portalLink = case_id ? `https://app.4lsg.com/docReq?case=${case_id}` : '';

    // Build SMS text — docs instruction on a separate line
    const bulletList = items.map(item => `• ${item}`).join('\n');
    let smsText = `HOMEWORK ASSIGNMENT\nWe need the following documents:\n\n${bulletList}`;
    if (send_docs_to === 'portal') {
      smsText += `\n\nPlease send the requested documents to DOCS@4LSG.COM or use our secure document upload portal at ${portalLink || 'app.4lsg.com/docReq'} . Thanks!`;
    } else if (send_docs_to === 'pdf') {
      smsText += '\n\nPlease send the .PDF documents to DOCS@4LSG.COM.';
    }

    // Build email HTML — instruction as its own paragraph with portal link
    let sendDocsHtml = '';
    if (send_docs_to === 'portal') {
      const linkHtml = portalLink
        ? `<a href="${portalLink}">secure document upload portal</a>`
        : 'secure document upload portal';
      sendDocsHtml = `<p><strong>Please send the requested documents to DOCS@4LSG.COM or use our ${linkHtml}. Thanks!</strong></p>`;
    } else if (send_docs_to === 'pdf') {
      sendDocsHtml = '<p><strong>Please send the .PDF documents to DOCS@4LSG.COM.</strong></p>';
    }

    const emailHtml = `<h3>Homework Assignment</h3>
<p>We need the following documents:</p>
<ul>
${items.map(item => `  <li>${escapeHtml(item)}</li>`).join('\n')}
</ul>
${sendDocsHtml}`;

    const emailText = `Homework Assignment\n\nWe need the following documents:\n\n${bulletList}` +
      (send_docs_to === 'portal' ? `\n\nPlease send the requested documents to DOCS@4LSG.COM or use our secure document upload portal at ${portalLink || 'app.4lsg.com/docReq'} . Thanks!` :
       send_docs_to === 'pdf' ? '\n\nPlease send the .PDF documents to DOCS@4LSG.COM.' : '');

    res.json({
      status: 'success',
      sms: smsText,
      email_text: emailText,
      email_html: emailHtml,
      checklist_items: items,
      warnings,
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