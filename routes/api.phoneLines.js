// routes/api.phoneLines.js
//
// SU-only admin CRUD for the phone_lines table. Mirrors the
// email_credentials admin tab pattern shipped in email Slice 4.
//
// The non-admin sender-dropdown endpoint (GET /api/phone-lines) lives
// in routes/api.sending.js and is intentionally left alone — it returns
// only active rows with the minimal shape needed by the compose UI.
// Endpoints here are namespaced under /api/phone-lines/admin and return
// the full admin shape (joined credential name/type, mms_capable, etc.).
//
// MMS capability is server-enforced: a row whose provider's adapter
// has capabilities.mms !== true cannot have mms_capable=1, no matter
// what the request body says. The GET response also surfaces the
// capability map so the UI can disable the corresponding controls.
//
// NO DELETE endpoint: phone_lines rows are referenced by campaigns,
// scheduled jobs, and historical logs. Deactivation only.

const express = require('express');
const router  = express.Router();

const { superuserOnlyFor, auditAdminAction } = require('../lib/auth.superuser');
const phoneService = require('../services/phoneService');

const TOOL = 'connections';

// ── Helpers ──────────────────────────────────────────────────────────

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',').shift() ||
    req.socket?.remoteAddress || null;
}
function userAgent(req) {
  return req.headers['user-agent'] || null;
}

// Fire-and-forget audit row. Failures log to stderr and don't bubble
// to the user.
function audit(db, req, status, details, errorMessage = null) {
  return auditAdminAction(db, {
    tool:         TOOL,
    userId:       req.auth?.userId   ?? null,
    username:     req.auth?.username ?? null,
    route:        req.originalUrl,
    method:       req.method,
    status,
    errorMessage,
    ip:           clientIp(req),
    userAgent:    userAgent(req),
    details,
  }).catch(err => console.error('[phoneLines admin] audit failed:', err.message));
}

// Normalize a phone string to 10 digits. Strips non-digits; drops a
// leading US "1". Returns null if the result isn't exactly 10 digits.
function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : digits;
  return /^\d{10}$/.test(ten) ? ten : null;
}

// Build the public-facing capability map { <provider>: { sms, mms } }.
// Sourced directly from each adapter's `capabilities` object so adding
// a new adapter (services/adapters/phone/<name>.js) auto-propagates to
// the UI without any frontend change.
function providerCapabilities() {
  const map = {};
  for (const [name, adapter] of Object.entries(phoneService.ADAPTERS)) {
    map[name] = {
      sms: adapter?.capabilities?.sms === true,
      mms: adapter?.capabilities?.mms === true,
    };
  }
  return map;
}

// Load a single row with the joined credential metadata used by the UI.
async function loadOne(db, id) {
  const [[row]] = await db.query(
    `SELECT pl.id, pl.phone_number, pl.display_name, pl.provider,
            pl.provider_id, pl.credential_id, pl.active, pl.mms_capable,
            c.name AS credential_name, c.type AS credential_type
       FROM phone_lines pl
       LEFT JOIN credentials c ON c.id = pl.credential_id
      WHERE pl.id = ? LIMIT 1`,
    [id]
  );
  return row || null;
}

// ── GET list ─────────────────────────────────────────────────────────

router.get('/api/phone-lines/admin', superuserOnlyFor(TOOL), async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT pl.id, pl.phone_number, pl.display_name, pl.provider,
              pl.provider_id, pl.credential_id, pl.active, pl.mms_capable,
              c.name AS credential_name, c.type AS credential_type
         FROM phone_lines pl
         LEFT JOIN credentials c ON c.id = pl.credential_id
        ORDER BY pl.id`
    );
    res.json({
      status: 'success',
      phone_lines: rows,
      providers: providerCapabilities(),
    });
  } catch (err) {
    console.error('GET /api/phone-lines/admin error:', err);
    audit(req.db, req, 'error', { action: 'list' }, err.message);
    res.status(500).json({ status: 'error', message: 'Failed to load phone lines' });
  }
});

// ── POST create ──────────────────────────────────────────────────────

router.post('/api/phone-lines/admin', superuserOnlyFor(TOOL), async (req, res) => {
  try {
    const body = req.body || {};

    // phone_number — required, must normalize to 10 digits
    const phone_number = normalizePhone(body.phone_number);
    if (!phone_number) {
      return res.status(400).json({ status: 'error', message: 'phone_number must be 10 digits.' });
    }

    // provider — required, must be in VALID_PROVIDERS
    const provider = String(body.provider || '').trim();
    if (!phoneService.VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        status: 'error',
        message: `provider must be one of: ${phoneService.VALID_PROVIDERS.join(', ')}`,
      });
    }

    // credential_id — required (column is NOT NULL); confirm it exists
    const credential_id = Number(body.credential_id);
    if (!Number.isInteger(credential_id) || credential_id <= 0) {
      return res.status(400).json({ status: 'error', message: 'credential_id is required.' });
    }
    const [[credRow]] = await req.db.query(
      'SELECT id FROM credentials WHERE id = ? LIMIT 1', [credential_id]
    );
    if (!credRow) {
      return res.status(400).json({ status: 'error', message: `credential_id ${credential_id} does not exist.` });
    }

    const display_name = body.display_name == null || body.display_name === ''
      ? null : String(body.display_name).slice(0, 50);
    const provider_id  = body.provider_id  == null || body.provider_id === ''
      ? null : String(body.provider_id).slice(0, 50);

    // mms_capable — server enforces against the adapter's capability.
    //   - body omits it: default to adapter capability (RC→1, Quo→0).
    //   - body explicit 1, adapter !mms: 400.
    //   - body explicit 0: always allowed.
    const adapter   = phoneService.ADAPTERS[provider];
    const adapterMms = adapter?.capabilities?.mms === true;
    let mms_capable;
    if (body.mms_capable == null) {
      mms_capable = adapterMms ? 1 : 0;
    } else {
      mms_capable = body.mms_capable ? 1 : 0;
      if (mms_capable === 1 && !adapterMms) {
        return res.status(400).json({
          status: 'error',
          message: `Provider '${provider}' does not support MMS — cannot set mms_capable=1.`,
        });
      }
    }

    const active = body.active == null ? 1 : (body.active ? 1 : 0);

    let result;
    try {
      [result] = await req.db.query(
        `INSERT INTO phone_lines
           (phone_number, provider, display_name, provider_id, credential_id, mms_capable, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [phone_number, provider, display_name, provider_id, credential_id, mms_capable, active]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          status: 'error',
          message: `Phone number ${phone_number} is already registered on another line.`,
        });
      }
      throw err;
    }

    const newRow = await loadOne(req.db, result.insertId);
    audit(req.db, req, 'success', {
      action: 'create',
      line_id: result.insertId,
      phone_number, provider, display_name, provider_id,
      credential_id, mms_capable, active,
    });
    res.status(201).json({ status: 'success', phone_line: newRow });
  } catch (err) {
    console.error('POST /api/phone-lines/admin error:', err);
    audit(req.db, req, 'error', { action: 'create' }, err.message);
    res.status(500).json({ status: 'error', message: err.message || 'Failed to create phone line' });
  }
});

// ── PUT update (partial) ─────────────────────────────────────────────

router.put('/api/phone-lines/admin/:id', superuserOnlyFor(TOOL), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: 'invalid id' });
  }
  try {
    const existing = await loadOne(req.db, id);
    if (!existing) return res.status(404).json({ status: 'error', message: 'Phone line not found.' });

    const body = req.body || {};
    const sets   = [];
    const params = [];
    const changed = {};

    if ('phone_number' in body) {
      const pn = normalizePhone(body.phone_number);
      if (!pn) return res.status(400).json({ status: 'error', message: 'phone_number must be 10 digits.' });
      sets.push('phone_number = ?'); params.push(pn); changed.phone_number = pn;
    }
    if ('provider' in body) {
      const prov = String(body.provider || '').trim();
      if (!phoneService.VALID_PROVIDERS.includes(prov)) {
        return res.status(400).json({
          status: 'error',
          message: `provider must be one of: ${phoneService.VALID_PROVIDERS.join(', ')}`,
        });
      }
      sets.push('provider = ?'); params.push(prov); changed.provider = prov;
    }
    if ('display_name' in body) {
      const v = body.display_name == null || body.display_name === ''
        ? null : String(body.display_name).slice(0, 50);
      sets.push('display_name = ?'); params.push(v); changed.display_name = v;
    }
    if ('provider_id' in body) {
      const v = body.provider_id == null || body.provider_id === ''
        ? null : String(body.provider_id).slice(0, 50);
      sets.push('provider_id = ?'); params.push(v); changed.provider_id = v;
    }
    if ('credential_id' in body) {
      const cid = Number(body.credential_id);
      if (!Number.isInteger(cid) || cid <= 0) {
        return res.status(400).json({ status: 'error', message: 'credential_id must be a positive integer.' });
      }
      const [[credRow]] = await req.db.query(
        'SELECT id FROM credentials WHERE id = ? LIMIT 1', [cid]
      );
      if (!credRow) {
        return res.status(400).json({ status: 'error', message: `credential_id ${cid} does not exist.` });
      }
      sets.push('credential_id = ?'); params.push(cid); changed.credential_id = cid;
    }
    if ('mms_capable' in body) {
      const v = body.mms_capable ? 1 : 0;
      sets.push('mms_capable = ?'); params.push(v); changed.mms_capable = v;
    }
    if ('active' in body) {
      const v = body.active ? 1 : 0;
      sets.push('active = ?'); params.push(v); changed.active = v;
    }

    if (!sets.length) {
      return res.json({ status: 'success', phone_line: existing, message: 'no changes' });
    }

    // Capability enforcement against the *effective* (post-update)
    // provider/mms pair. Catches every shape: switching provider to a
    // no-MMS one while leaving mms_capable=1 untouched is just as
    // invalid as flipping mms_capable=1 on an existing Quo line.
    const effectiveProvider = 'provider'    in body ? body.provider                : existing.provider;
    const effectiveMms      = 'mms_capable' in body ? (body.mms_capable ? 1 : 0)   : (existing.mms_capable ? 1 : 0);
    if (effectiveMms === 1) {
      const adapter = phoneService.ADAPTERS[effectiveProvider];
      if (adapter?.capabilities?.mms !== true) {
        return res.status(400).json({
          status: 'error',
          message: `Provider '${effectiveProvider}' does not support MMS — cannot set mms_capable=1. ` +
                   `If you're changing provider away from an MMS-capable one, set mms_capable=0 in the same request.`,
        });
      }
    }

    params.push(id);
    try {
      await req.db.query(`UPDATE phone_lines SET ${sets.join(', ')} WHERE id = ?`, params);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          status: 'error',
          message: 'Phone number is already registered on another line.',
        });
      }
      throw err;
    }

    const updated = await loadOne(req.db, id);
    audit(req.db, req, 'success', { action: 'update', line_id: id, changed });
    res.json({ status: 'success', phone_line: updated });
  } catch (err) {
    console.error('PUT /api/phone-lines/admin/:id error:', err);
    audit(req.db, req, 'error', { action: 'update', line_id: id }, err.message);
    res.status(500).json({ status: 'error', message: err.message || 'Failed to update phone line' });
  }
});

// ── PATCH active toggle ──────────────────────────────────────────────

router.patch('/api/phone-lines/admin/:id/active', superuserOnlyFor(TOOL), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: 'invalid id' });
  }
  try {
    const existing = await loadOne(req.db, id);
    if (!existing) return res.status(404).json({ status: 'error', message: 'Phone line not found.' });

    const next = req.body?.active ? 1 : 0;
    await req.db.query('UPDATE phone_lines SET active = ? WHERE id = ?', [next, id]);
    const updated = await loadOne(req.db, id);
    audit(req.db, req, 'success', {
      action: 'toggle_active',
      line_id: id,
      from: existing.active ? 1 : 0,
      to:   next,
    });
    res.json({ status: 'success', phone_line: updated });
  } catch (err) {
    console.error('PATCH /api/phone-lines/admin/:id/active error:', err);
    audit(req.db, req, 'error', { action: 'toggle_active', line_id: id }, err.message);
    res.status(500).json({ status: 'error', message: 'Failed to toggle active' });
  }
});

// ── PATCH mms_capable toggle ─────────────────────────────────────────

router.patch('/api/phone-lines/admin/:id/mms-capable', superuserOnlyFor(TOOL), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: 'invalid id' });
  }
  try {
    const existing = await loadOne(req.db, id);
    if (!existing) return res.status(404).json({ status: 'error', message: 'Phone line not found.' });

    const next = req.body?.mms_capable ? 1 : 0;

    // Capability enforcement. Toggle endpoint operates against the
    // existing provider — there's no provider change here. Reject any
    // attempt to enable MMS on a no-MMS adapter.
    if (next === 1) {
      const adapter = phoneService.ADAPTERS[existing.provider];
      if (adapter?.capabilities?.mms !== true) {
        return res.status(400).json({
          status: 'error',
          message: `Provider '${existing.provider}' does not support MMS — cannot enable mms_capable.`,
        });
      }
    }

    await req.db.query('UPDATE phone_lines SET mms_capable = ? WHERE id = ?', [next, id]);
    const updated = await loadOne(req.db, id);
    audit(req.db, req, 'success', {
      action: 'toggle_mms_capable',
      line_id: id,
      from: existing.mms_capable ? 1 : 0,
      to:   next,
    });
    res.json({ status: 'success', phone_line: updated });
  } catch (err) {
    console.error('PATCH /api/phone-lines/admin/:id/mms-capable error:', err);
    audit(req.db, req, 'error', { action: 'toggle_mms_capable', line_id: id }, err.message);
    res.status(500).json({ status: 'error', message: 'Failed to toggle mms_capable' });
  }
});

// ── POST test SMS ────────────────────────────────────────────────────

router.post('/api/phone-lines/admin/:id/test-sms', superuserOnlyFor(TOOL), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: 'invalid id' });
  }
  try {
    const line = await loadOne(req.db, id);
    if (!line) return res.status(404).json({ status: 'error', message: 'Phone line not found.' });

    const to      = String(req.body?.to      || '').trim();
    const message = String(req.body?.message || '').trim();
    if (!to)      return res.status(400).json({ status: 'error', message: 'to is required.' });
    if (!message) return res.status(400).json({ status: 'error', message: 'message is required.' });

    // phoneService.sendSms resolves the line by its 10-digit `from`, runs
    // capability checks, calls the adapter, and writes to rc_messages_log.
    const result = await phoneService.sendSms(req.db, line.phone_number, to, message);
    audit(req.db, req, 'success', {
      action: 'test_sms',
      line_id: id,
      from: line.phone_number,
      to,
      message_length: message.length,
    });
    res.json({ status: 'success', result });
  } catch (err) {
    console.error('POST /api/phone-lines/admin/:id/test-sms error:', err);
    audit(req.db, req, 'error', { action: 'test_sms', line_id: id }, err.message);
    res.status(500).json({ status: 'error', message: err.message || 'Failed to send test SMS' });
  }
});

module.exports = router;