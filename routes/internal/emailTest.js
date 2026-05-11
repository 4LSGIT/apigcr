/**
 * Internal Email Test Route — diagnostic only.
 *
 *   GET  /internal/email-test/credentials
 *        List email_credentials rows (smtp_pass omitted).
 *
 *   GET  /internal/email-test/credentials/oauth                  [Slice 2]
 *        List credentials rows where type='oauth2'. Tokens are NOT decrypted
 *        or returned — only presence flags + expiry metadata. client_secret
 *        is stripped from the returned config blob.
 *
 *   POST /internal/email-test/send
 *        Body: {
 *          from_id,                  // email_credentials.id — optional iff
 *                                    //   from_email_override is provided
 *          to,                       // string or string[]
 *          subject,
 *          text?,
 *          html?,
 *          attachments?,             // smtp-style inline (nodemailer format)
 *          attachmentUrls?,          // string | object | array — passed as attachment_urls
 *
 *          // Slice 2 overrides — when ANY is set, the route bypasses the
 *          // public emailService.sendEmail and calls sendEmailDirect with
 *          // a cloned-or-synthesized emailRow. Lets Fred test Gmail through
 *          // any verified Send-as alias without modifying any production
 *          // email_credentials row.
 *          provider_override?,       // 'gmail' | 'smtp' | 'pabbly'
 *          credential_id_override?,  // number | null
 *          from_email_override?,     // string (verified alias address)
 *          from_name_override?,      // string
 *        }
 *        Returns { ok, result } / { ok: false, error }.
 *
 * JWT-guarded. Routes auto-mount via the routes/internal/ scan.
 */

const express      = require('express');
const router       = express.Router();
const jwtOrApiKey  = require('../../lib/auth.jwtOrApiKey');
const emailService = require('../../services/emailService');

// ─────────────────────────────────────────────────────────────
// GET /internal/email-test/credentials
//   List email_credentials rows. smtp_pass intentionally omitted.
// ─────────────────────────────────────────────────────────────

router.get('/internal/email-test/credentials', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT id, email, provider, from_name, credential_id
         FROM email_credentials
         ORDER BY id`
    );
    res.json({ ok: true, credentials: rows });
  } catch (err) {
    console.error('[email-test] GET credentials failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /internal/email-test/credentials/oauth
//
//   List credentials rows where type='oauth2'. NO secrets are decrypted
//   or returned. The credentials.config blob is parsed and client_secret
//   is stripped. Other config fields (auth_url, token_url, scopes,
//   client_id, etc.) are returned so Fred can identify which connector
//   each credential targets — the schema has no explicit provider
//   distinguisher column, so the auth_url + scopes are the only "which
//   provider is this?" tells.
// ─────────────────────────────────────────────────────────────

router.get('/internal/email-test/credentials/oauth', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT id, name, oauth_status,
              access_token_expires_at, last_refreshed_at,
              CASE WHEN access_token  IS NULL THEN 0 ELSE 1 END AS has_access_token,
              CASE WHEN refresh_token IS NULL THEN 0 ELSE 1 END AS has_refresh_token,
              config, allowed_urls
         FROM credentials
        WHERE type = 'oauth2'
        ORDER BY id`
    );

    const sanitized = rows.map(r => {
      let cfg = null;
      try {
        cfg = r.config
          ? (typeof r.config === 'string' ? JSON.parse(r.config) : r.config)
          : null;
        if (cfg && typeof cfg === 'object' && 'client_secret' in cfg) {
          delete cfg.client_secret;
        }
      } catch {
        cfg = null;
      }
      let allowed = null;
      try {
        allowed = r.allowed_urls
          ? (typeof r.allowed_urls === 'string' ? JSON.parse(r.allowed_urls) : r.allowed_urls)
          : null;
      } catch {
        allowed = null;
      }
      return {
        id: r.id,
        name: r.name,
        oauth_status: r.oauth_status,
        has_access_token:  !!r.has_access_token,
        has_refresh_token: !!r.has_refresh_token,
        access_token_expires_at: r.access_token_expires_at,
        last_refreshed_at:       r.last_refreshed_at,
        config: cfg,                 // client_secret stripped
        allowed_urls: allowed,
      };
    });

    res.json({ ok: true, credentials: sanitized });
  } catch (err) {
    console.error('[email-test] GET credentials/oauth failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /internal/email-test/send
//
//   No overrides → look up emailRow by from_id, call public sendEmail.
//   Any override given → load baseRow if from_id, apply overrides,
//                        call sendEmailDirect.
//
//   Override semantics: a missing override field falls back to the
//   loaded baseRow's value. To use an override path without a base row,
//   from_email_override must be provided (since the resolved emailRow
//   needs an `email` value).
// ─────────────────────────────────────────────────────────────

router.post('/internal/email-test/send', jwtOrApiKey, async (req, res) => {
  const {
    from_id, to, subject, text, html,
    attachments, attachmentUrls,
    provider_override,
    credential_id_override,
    from_email_override,
    from_name_override,
  } = req.body || {};

  if (!to || !subject) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: to, subject',
    });
  }

  const usingOverrides = (
    provider_override     !== undefined ||
    credential_id_override !== undefined ||
    from_email_override   !== undefined ||
    from_name_override    !== undefined
  );

  if (!from_id && !usingOverrides) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required field: from_id (or provide overrides)',
    });
  }
  if (!from_id && !from_email_override) {
    return res.status(400).json({
      ok: false,
      error: 'When from_id is omitted, from_email_override is required',
    });
  }

  try {
    // ─── No overrides → original public path ───
    if (!usingOverrides) {
      const [[row]] = await req.db.query(
        'SELECT email FROM email_credentials WHERE id = ? LIMIT 1',
        [from_id]
      );
      if (!row) {
        return res.status(404).json({
          ok: false,
          error: `No email_credentials row with id=${from_id}`,
        });
      }

      const result = await emailService.sendEmail(req.db, {
        from:            row.email,
        to,
        subject,
        text,
        html,
        attachments,
        attachment_urls: attachmentUrls,
      });

      return res.json({ ok: true, result });
    }

    // ─── Overrides path → load baseRow if from_id, then clone+mutate ───
    let baseRow = null;
    if (from_id) {
      const [[row]] = await req.db.query(
        'SELECT * FROM email_credentials WHERE id = ? LIMIT 1',
        [from_id]
      );
      if (!row) {
        return res.status(404).json({
          ok: false,
          error: `No email_credentials row with id=${from_id}`,
        });
      }
      baseRow = row;
    }

    const emailRow = {
      id:            baseRow?.id ?? null,
      email:         from_email_override ?? baseRow?.email,
      from_name:     from_name_override  ?? baseRow?.from_name ?? '',
      provider:      provider_override   ?? baseRow?.provider,
      // credential_id_override may legitimately be null (to clear linkage);
      // distinguish "not set" from "set to null" by checking undefined.
      credential_id: (credential_id_override !== undefined)
                       ? credential_id_override
                       : (baseRow?.credential_id ?? null),
      // SMTP-only columns — passed through verbatim if a base row exists,
      // unused for gmail/pabbly providers. The smtp adapter reads these.
      smtp_host:   baseRow?.smtp_host,
      smtp_port:   baseRow?.smtp_port,
      smtp_user:   baseRow?.smtp_user,
      smtp_pass:   baseRow?.smtp_pass,
      smtp_secure: baseRow?.smtp_secure,
    };

    if (!emailRow.email) {
      return res.status(400).json({
        ok: false,
        error: 'Resolved emailRow has no email — provide from_email_override or a from_id whose row has an email',
      });
    }
    if (!emailRow.provider) {
      return res.status(400).json({
        ok: false,
        error: 'Resolved emailRow has no provider — provide provider_override or a from_id whose row has a provider',
      });
    }

    const result = await emailService.sendEmailDirect(req.db, emailRow, {
      from:            emailRow.email,
      to,
      subject,
      text,
      html,
      attachments,
      attachment_urls: attachmentUrls,
    });

    return res.json({
      ok: true,
      result,
      // Echo the resolved emailRow (sans smtp_pass) so the operator can
      // confirm what was actually used.
      resolved_email_row: {
        id:            emailRow.id,
        email:         emailRow.email,
        from_name:     emailRow.from_name,
        provider:      emailRow.provider,
        credential_id: emailRow.credential_id,
      },
    });
  } catch (err) {
    console.error('[email-test] POST send failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;