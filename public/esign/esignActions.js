// public/esign/esignActions.js
//
// ─────────────────────────────────────────────────────────────
// Shared e-sign UI module (Phase 2C).
//
// Loaded the same way as scripts.js / automation/paramsMapping.js: a plain
// <script src> on non-module pages (esign/caseWidget.html, esign/dashboard.html,
// esign/sendForm.html), exposing its API on `window`.
//
// TWO SECTIONS, deliberately separated:
//
//   1. PURE HELPERS — no DOM, no network, no globals. These are the status→
//      chip mapping, date/days-pending formatting, the per-recipient state
//      summarizer, the event-timeline line formatter, and the action-
//      availability rules (which mirror the SERVICE constants in
//      services/esignSendService.js: REMINDABLE, RESENDABLE_SAME_ROW,
//      SATISFIABLE, TERMINAL — if those change, change these). Exported via a
//      guarded module.exports so tests/esignActionsUi.test.js can require this
//      file under plain node jest (repo test env — no browser infra exists).
//
//   2. BROWSER SECTION — network plumbing + the shared action dialogs
//      (Detail / Nudge / Recall / Resend / Mark satisfied). Guarded behind
//      `typeof window !== 'undefined'` so requiring the file in node never
//      touches document/Swal.
//
// ── NETWORK CONTRACT ─────────────────────────────────────────
// JSON calls ride window.top.apiSend (courtpreview.html precedent — the shell
// index.html owns auth; these pages may be nested 2+ iframes deep).
// Multipart uploads and the binary PDF preview CANNOT ride apiSend (it is
// JSON-only), so they use fetch with `Authorization: Bearer <jwt>` where the
// jwt comes from top.AUTH_STATE.jwt || localStorage 'jwt' — the established
// raw-fetch pattern (assetManager.html, dbConsole.html, systemAlerts.html).
//
// ── RESEND RULES (from the repo, NOT the obvious UX) ─────────
// POST /api/esign/:id/resend requires a PDF in EVERY mode — the route 400s
// without one and resendPipeline stamps the buffer in both branches. The
// unsigned PDF of a sent request is not stored anywhere retrievable, so:
//   bounced          → same-row resend: editable recipient emails + a REQUIRED
//                      file input (staff re-attach the document).
//   terminal         → duplicate-as-new: REQUIRED file input. If the original
//     (declined/       was template-made (row.template_id), the dialog points
//      recalled/       at the send form prefilled instead — re-manufacturing
//      expired)        from the template is the correct path for those.
//   anything else    → not offered (recall first; that must be deliberate).
// ─────────────────────────────────────────────────────────────

/* ══════════════════════════════════════════════════════════════
   SECTION 1 — PURE HELPERS (node-safe, Jest-covered)
   ══════════════════════════════════════════════════════════════ */

/** Request-status → chip meta. Colors per 2C spec:
    sent/viewed amber, signed green, declined/bounced/expired red,
    recalled/satisfied_external gray. draft (rare on these surfaces — only a
    failed provider send leaves one) renders indigo like a pending task. */
var ESIGN_STATUS_META = {
  draft:              { label: 'Draft',              fg: '#ffffff', bg: '#4f46e5' },
  sent:               { label: 'Sent',               fg: '#7c4a03', bg: '#fde68a' },
  viewed:             { label: 'Viewed',             fg: '#7c4a03', bg: '#fcd34d' },
  signed:             { label: 'Signed',             fg: '#ffffff', bg: '#059669' },
  declined:           { label: 'Declined',           fg: '#ffffff', bg: '#dc2626' },
  expired:            { label: 'Expired',            fg: '#ffffff', bg: '#b91c1c' },
  bounced:            { label: 'Bounced',            fg: '#ffffff', bg: '#ef4444' },
  recalled:           { label: 'Recalled',           fg: '#ffffff', bg: '#6b7280' },
  satisfied_external: { label: 'Satisfied (paper)',  fg: '#ffffff', bg: '#6b7280' },
};

function esignStatusChip(status) {
  return ESIGN_STATUS_META[status] ||
    { label: String(status == null ? '?' : status), fg: '#ffffff', bg: '#6b7280' };
}

/** Mirrors of the service-side state sets (services/esignSendService.js). */
var ESIGN_TERMINAL    = ['signed', 'declined', 'expired', 'recalled', 'satisfied_external'];
var ESIGN_REMINDABLE  = ['sent', 'viewed'];
var ESIGN_SATISFIABLE = ['sent', 'viewed', 'bounced'];

function esignIsTerminal(status)  { return ESIGN_TERMINAL.indexOf(status) !== -1; }
function esignCanRemind(status)   { return ESIGN_REMINDABLE.indexOf(status) !== -1; }
function esignCanSatisfy(status)  { return ESIGN_SATISFIABLE.indexOf(status) !== -1; }
/** Recall: any non-terminal status (recallPipeline rejects only TERMINAL). */
function esignCanRecall(status)   { return status != null && !esignIsTerminal(status); }

/**
 * Which resend flavour a row is eligible for.
 *   'bounced'   → same-row re-send (edit emails, re-attach PDF)
 *   'duplicate' → terminal duplicate-as-new (declined/recalled/expired;
 *                 NOT signed / satisfied_external — nothing to re-do)
 *   null        → not offered
 */
function esignResendMode(status) {
  if (status === 'bounced') return 'bounced';
  if (status === 'declined' || status === 'recalled' || status === 'expired') return 'duplicate';
  return null;
}

/** sent_at → whole days pending (floor), or null when never sent. Pure so it
    is testable: `now` is injectable and defaults to Date.now(). */
function esignDaysPending(sentAt, now) {
  if (!sentAt) return null;
  var t = new Date(sentAt).getTime();
  if (!isFinite(t)) return null;
  var ref = (now == null ? Date.now() : now);
  var d = Math.floor((ref - t) / 86400000);
  return d < 0 ? 0 : d;
}

/** Datetime-ish → 'Jul 19, 2026' (local), '' when empty/unparseable. */
function esignFmtDate(v) {
  if (!v) return '';
  var d = new Date(v);
  if (!isFinite(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Datetime-ish → 'Jul 19, 2026, 3:04 PM' (local), '' when empty. */
function esignFmtDateTime(v) {
  if (!v) return '';
  var d = new Date(v);
  if (!isFinite(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** 'Jane Q Smith' → 'JS'; falls back to the email's first two letters. */
function esignInitials(name, email) {
  var n = String(name == null ? '' : name).trim();
  if (n) {
    var parts = n.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  var e = String(email == null ? '' : email).trim();
  return e ? e.slice(0, 2).toUpperCase() : '??';
}

/**
 * Per-recipient state → icon meta. Recipient status vocabulary comes from
 * esignService._normalizeRecipients ('pending' default) + the webhook mapper
 * (signed / declined / bounced / viewed). Anything unknown renders as pending.
 *   signed          → tick, green
 *   viewed          → eye, amber
 *   declined/bounced→ cross, red
 *   pending/other   → clock, gray
 */
function esignRecipientState(status) {
  switch (status) {
    case 'signed':   return { icon: 'fa-check',  cls: 'esr-green', title: 'Signed' };
    case 'viewed':   return { icon: 'fa-eye',    cls: 'esr-amber', title: 'Viewed' };
    case 'declined': return { icon: 'fa-xmark',  cls: 'esr-red',   title: 'Declined' };
    case 'bounced':  return { icon: 'fa-xmark',  cls: 'esr-red',   title: 'Email bounced' };
    default:         return { icon: 'fa-clock',  cls: 'esr-gray',  title: 'Awaiting signature' };
  }
}

/** [{name,email,status}] → [{initials, icon, cls, title}] for compact display.
    title carries name + email + state so hover explains the glyph. */
function esignRecipientsSummary(recipients) {
  return (Array.isArray(recipients) ? recipients : []).map(function (r) {
    var st = esignRecipientState(r && r.status);
    return {
      initials: esignInitials(r && r.name, r && r.email),
      icon: st.icon,
      cls: st.cls,
      title: ((r && r.name) || (r && r.email) || 'Recipient') +
        ((r && r.email && r.name) ? ' <' + r.email + '>' : '') + ' — ' + st.title,
    };
  });
}

/**
 * One signing_request_events row → a human-readable timeline line.
 * Payload details stay collapsed in the dialog; this is the headline only.
 */
function esignEventLine(evt) {
  if (!evt) return '';
  var who = evt.recipient_email ? ' — ' + evt.recipient_email : '';
  var p = evt.payload || {};
  switch (evt.event) {
    case 'created':             return 'Request created';
    case 'sent':                return 'Sent for signature' + who;
    case 'viewed':              return 'Opened by signer' + who;
    case 'signed':              return 'Signed' + who;
    case 'declined':            return 'Declined' + who + (p.reason ? ' — “' + p.reason + '”' : '');
    case 'bounced':             return 'Email bounced' + who;
    case 'recalled':            return 'Recalled' + (p.reason ? ' — “' + p.reason + '”' : '');
    case 'expired':             return 'Expired';
    case 'reminded':            return 'Reminder sent to all pending signers';
    case 'send_failed':         return 'Send failed' + (p.error ? ' — ' + p.error : '');
    case 'resent':              return 'Re-sent' + who;
    case 'superseded_by':       return 'Superseded by request #' + (p.new_request_id != null ? p.new_request_id : '?');
    case 'duplicates':          return 'Duplicated from request #' + (p.previous_request_id != null ? p.previous_request_id : '?');
    case 'satisfied_external':  return 'Marked satisfied outside e-sign' + (p.note ? ' — “' + p.note + '”' : '');
    case 'filed':               return 'Signed document filed to the case';
    case 'filing_failed':       return 'Filing failed' + (p.error ? ' — ' + p.error : '');
    case 'credit_spend_failed': return 'Credit accounting warning';
    default:                    return String(evt.event || 'event');
  }
}

/** HTML escape (text-node context). Same trio every page in this repo uses. */
function esignEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Guarded export — lets tests/esignActionsUi.test.js require the pure section
   under node jest. In the browser `module` is undefined and this is skipped. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ESIGN_STATUS_META: ESIGN_STATUS_META,
    esignStatusChip: esignStatusChip,
    esignIsTerminal: esignIsTerminal,
    esignCanRemind: esignCanRemind,
    esignCanRecall: esignCanRecall,
    esignCanSatisfy: esignCanSatisfy,
    esignResendMode: esignResendMode,
    esignDaysPending: esignDaysPending,
    esignFmtDate: esignFmtDate,
    esignFmtDateTime: esignFmtDateTime,
    esignInitials: esignInitials,
    esignRecipientState: esignRecipientState,
    esignRecipientsSummary: esignRecipientsSummary,
    esignEventLine: esignEventLine,
    esignEsc: esignEsc,
  };
}

/* ══════════════════════════════════════════════════════════════
   SECTION 2 — BROWSER ONLY (network + dialogs)
   ══════════════════════════════════════════════════════════════ */
if (typeof window !== 'undefined') (function () {
  'use strict';

  // ── shell plumbing ─────────────────────────────────────────
  function _top() {
    // Same-origin everywhere in this app; the try guards a hypothetical
    // cross-origin embed rather than anything that exists today.
    try { return window.top || window; } catch (_) { return window; }
  }

  /** JSON API relay — the shell's auth wrapper (courtpreview precedent). */
  function esignApi() {
    var t = _top();
    if (t && typeof t.apiSend === 'function') return t.apiSend.apply(t, arguments);
    return Promise.reject(new Error('apiSend unavailable — open this page inside YisraCase.'));
  }

  function esignJwt() {
    var t = _top();
    return (t && t.AUTH_STATE && t.AUTH_STATE.jwt) || localStorage.getItem('jwt') || '';
  }

  /** Multipart POST (uploads MUST be multipart — the global express.json
      ~7.5MB base64 ceiling is a server.js constraint, see api.esign.actions.js
      header). Throws Error(message) with .body carrying the server JSON. */
  async function esignUpload(path, formData) {
    var res = await fetch(path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + esignJwt() },
      body: formData,
    });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { _raw: text }; }
    if (!res.ok) {
      var err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
      err.status = res.status;
      err.body = data || {};
      throw err;
    }
    return data;
  }

  /** Binary PDF POST (template preview). Returns {blob, missing:[]} — the
      X-Esign-Missing header lists still-empty keys. Error responses are JSON;
      parsed and rethrown with the server's message. */
  async function esignFetchPdf(path, bodyObj) {
    var res = await fetch(path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + esignJwt(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyObj || {}),
    });
    if (!res.ok) {
      var text = await res.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { }
      var err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
      err.status = res.status;
      err.body = data || {};
      throw err;
    }
    var missingHeader = res.headers.get('X-Esign-Missing') || '';
    var missing = missingHeader.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var blob = await res.blob();
    return { blob: blob, missing: missing };
  }

  // ── styles (guarded single injection — injectLogHelpersStyles idiom) ──
  (function injectEsignStyles() {
    if (document.getElementById('esign-actions-styles')) return;
    var style = document.createElement('style');
    style.id = 'esign-actions-styles';
    style.textContent = [
      '.es-chip { display:inline-block; padding:2px 9px; border-radius:10px;',
      '  font-size:11px; font-weight:bold; white-space:nowrap; }',
      '.es-recips { display:inline-flex; gap:6px; flex-wrap:wrap; }',
      '.es-recip { display:inline-flex; align-items:center; gap:3px;',
      '  font-size:11px; padding:1px 6px; border-radius:9px; background:#f2f2f2;',
      '  border:1px solid #ddd; white-space:nowrap; }',
      '.esr-green { color:#059669; } .esr-amber { color:#b45309; }',
      '.esr-red { color:#dc2626; }  .esr-gray { color:#6b7280; }',
      '.es-events { text-align:left; max-height:45vh; overflow:auto;',
      '  font-size:13px; border:1px solid #eee; border-radius:4px; padding:8px 10px; }',
      '.es-event { padding:4px 0; border-bottom:1px solid #f2f2f2; }',
      '.es-event:last-child { border-bottom:none; }',
      '.es-event .es-when { color:#888; font-size:11px; }',
      '.es-event pre { text-align:left; font-size:11px; background:#f8f8f8;',
      '  padding:6px; border-radius:3px; overflow:auto; max-height:12em; margin:4px 0 0; }',
      '.es-payload-toggle { color:#07adef; cursor:pointer; font-size:11px; margin-left:6px; }',
      '.es-meta { font-size:13px; border-collapse:collapse; text-align:left; }',
      '.es-meta td { padding:3px 10px 3px 0; vertical-align:top; }',
      '.es-meta td:first-child { color:#6b7280; white-space:nowrap; }',
      '.es-dialog-note { font-size:12px; color:#666; text-align:left; margin:6px 0; }',
      '.es-counter { font-size:11px; color:#888; text-align:right; }',
      '.es-recip-edit input { width:45%; margin:2px 1%; padding:6px; }',
    ].join('\n');
    document.head.appendChild(style);
  })();

  // ── small HTML builders ────────────────────────────────────
  function esignChipHtml(status) {
    var m = esignStatusChip(status);
    return '<span class="es-chip" style="background:' + m.bg + ';color:' + m.fg + '">' +
      esignEsc(m.label) + '</span>';
  }

  function esignRecipientsHtml(recipients) {
    var items = esignRecipientsSummary(recipients);
    if (!items.length) return '<span style="color:#999">—</span>';
    return '<span class="es-recips">' + items.map(function (it) {
      return '<span class="es-recip" title="' + esignEsc(it.title).replace(/"/g, '&quot;') + '">' +
        esignEsc(it.initials) +
        ' <i class="fa-solid ' + it.icon + ' ' + it.cls + '"></i></span>';
    }).join('') + '</span>';
  }

  function _swal() {
    // Each page loads sweetalert2 itself (repo convention); this is just a
    // clear failure if one forgets.
    if (typeof Swal === 'undefined') throw new Error('SweetAlert2 not loaded');
    return Swal;
  }
  function _toast(icon, title, text) {
    if (typeof Toast !== 'undefined') return Toast.fire({ icon: icon, title: title, text: text || undefined });
    _swal().fire({ icon: icon, title: title, text: text || undefined, timer: 2500, showConfirmButton: false });
  }

  // ── DETAIL dialog ──────────────────────────────────────────
  // Full request info + event timeline (GET /api/esign/:id), newest first,
  // payloads collapsed behind a click.
  async function esignDetailDialog(id, onChange) {
    var data;
    try {
      data = await esignApi('/api/esign/' + id, 'GET');
    } catch (err) {
      _toast('error', 'Error loading request', err.message);
      return;
    }
    var r = data.request || {};
    var events = (data.events || []).slice().reverse();   // newest first

    var meta = function (label, valHtml) {
      return valHtml ? '<tr><td>' + label + '</td><td>' + valHtml + '</td></tr>' : '';
    };
    var recipsLong = (r.recipients || []).map(function (rc) {
      var st = esignRecipientState(rc.status);
      return '<div><i class="fa-solid ' + st.icon + ' ' + st.cls + '"></i> ' +
        esignEsc(rc.name || '') + ' &lt;' + esignEsc(rc.email || '') + '&gt; — ' + st.title + '</div>';
    }).join('');

    var eventsHtml = events.length
      ? '<div class="es-events">' + events.map(function (e, i) {
          var hasPayload = e.payload && Object.keys(e.payload).length;
          return '<div class="es-event">' +
            '<div>' + esignEsc(esignEventLine(e)) +
            (hasPayload
              ? '<span class="es-payload-toggle" onclick="var p=this.parentNode.parentNode.querySelector(\'pre\');p.style.display=p.style.display===\'none\'?\'block\':\'none\'">details</span>'
              : '') +
            '</div>' +
            '<div class="es-when">' + esignEsc(esignFmtDateTime(e.occurred_at || e.created_at)) + '</div>' +
            (hasPayload ? '<pre style="display:none">' + esignEsc(JSON.stringify(e.payload, null, 2)) + '</pre>' : '') +
            '</div>';
        }).join('') + '</div>'
      : '<div class="es-dialog-note">No events recorded.</div>';

    _swal().fire({
      title: '<span style="font-size:18px">' + esignEsc(r.document_name || ('Request #' + id)) + '</span>',
      html:
        '<div style="text-align:left">' +
        '<div style="margin:0 0 10px">' + esignChipHtml(r.status) +
        (r.days_pending != null && !esignIsTerminal(r.status)
          ? ' <span style="font-size:12px;color:#888">' + r.days_pending + ' day' + (r.days_pending === 1 ? '' : 's') + ' pending</span>' : '') +
        '</div>' +
        '<table class="es-meta">' +
        meta('Tracking id', '<span onclick="copy && copy(this.innerText)" style="cursor:pointer">' + esignEsc(r.tracking_id || '') + '</span>') +
        meta('Kind', esignEsc(r.kind || '')) +
        meta('Linked to', esignEsc((r.linkable_type || '') + ' ' + (r.linkable_id || ''))) +
        meta('Sent', esignEsc(esignFmtDateTime(r.sent_at))) +
        meta('Expires', esignEsc(esignFmtDate(r.expires_at))) +
        meta('Completed', esignEsc(esignFmtDateTime(r.completed_at))) +
        meta('Template', r.template_id != null ? '#' + r.template_id : '') +
        meta('Signed PDF', r.signed_pdf_path ? esignEsc(r.signed_pdf_path) : '') +
        '</table>' +
        '<div style="margin:10px 0 4px;font-weight:bold">Recipients</div>' + (recipsLong || '—') +
        '<div style="margin:12px 0 4px;font-weight:bold">Timeline (newest first)</div>' + eventsHtml +
        '</div>',
      width: 680,
      showConfirmButton: false,
      showCloseButton: true,
    });
  }

  // ── NUDGE (remind) ─────────────────────────────────────────
  function esignRemindDialog(row, onChange) {
    _swal().fire({
      title: 'Send a reminder?',
      html: '<div class="es-dialog-note" style="text-align:center">This reminds ' +
        '<b>ALL pending recipients</b> — Zoho has no per-recipient reminder.</div>',
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Remind all',
      showLoaderOnConfirm: true,
      allowOutsideClick: function () { return !_swal().isLoading(); },
      preConfirm: async function () {
        try {
          await esignApi('/api/esign/' + row.id + '/remind', 'POST', {});
        } catch (err) {
          _swal().showValidationMessage(err.message);
          return false;
        }
      },
    }).then(function (result) {
      if (result.isConfirmed) {
        _toast('success', 'Reminder sent to all pending signers');
        if (onChange) onChange();
      }
    });
  }

  // ── RECALL ─────────────────────────────────────────────────
  function esignRecallDialog(row, onChange) {
    _swal().fire({
      title: 'Recall this request',
      html:
        '<div class="es-dialog-note">The signing link the client has stops working. ' +
        'A reason is required and is kept on the audit trail.</div>' +
        '<textarea id="es-recall-reason" maxlength="500" ' +
        'style="width:100%;height:80px;resize:vertical;box-sizing:border-box" ' +
        'oninput="document.getElementById(\'es-recall-count\').innerText=this.value.trim().length+\' / 500\'"></textarea>' +
        '<div id="es-recall-count" class="es-counter">0 / 500</div>',
      showCancelButton: true,
      confirmButtonText: 'Recall',
      confirmButtonColor: '#b91c1c',
      showLoaderOnConfirm: true,
      allowOutsideClick: function () { return !_swal().isLoading(); },
      preConfirm: async function () {
        var reason = document.getElementById('es-recall-reason').value.trim();
        if (reason.length < 1 || reason.length > 500) {
          _swal().showValidationMessage('A recall reason of 1–500 characters is required.');
          return false;
        }
        try {
          await esignApi('/api/esign/' + row.id + '/recall', 'POST', { reason: reason });
        } catch (err) {
          _swal().showValidationMessage(err.message);
          return false;
        }
      },
    }).then(function (result) {
      if (result.isConfirmed) {
        _toast('success', 'Recalled');
        if (onChange) onChange();
      }
    });
  }

  // ── RESEND ─────────────────────────────────────────────────
  // See RESEND RULES in the header. `sendFormUrl` builds the prefilled send
  // form link for template-made originals.
  function _sendFormUrl(row) {
    var q = 'case_id=' + encodeURIComponent(row.linkable_id) +
      (row.template_id != null ? '&template_id=' + encodeURIComponent(row.template_id) : '');
    return '/esign/sendForm.html?' + q;
  }

  function esignResendDialog(row, onChange) {
    var mode = esignResendMode(row.status);
    if (!mode) {
      _toast('info', 'Not re-sendable', 'Active requests must be recalled first.');
      return;
    }

    // Template-made terminal request → the send form re-manufactures the PDF;
    // duplicating with a hand upload is the wrong tool. Offer the link, plus
    // the manual path for completeness.
    var templateNote = (mode === 'duplicate' && row.template_id != null && row.linkable_type === 'case')
      ? '<div class="es-dialog-note" style="border-left:3px solid #07adef;padding-left:8px">' +
        'This document was made from a template. The better path is to ' +
        '<a href="' + _sendFormUrl(row) + '">send it again from the template</a> ' +
        '(prefilled) — the PDF is re-manufactured with current case data.</div>'
      : '';

    var recipRows = (row.recipients || []).map(function (r, i) {
      return '<div class="es-recip-edit">' +
        '<input class="es-rs-name" placeholder="Name" value="' + esignEsc(r.name || '').replace(/"/g, '&quot;') + '">' +
        '<input class="es-rs-email" placeholder="Email" value="' + esignEsc(r.email || '').replace(/"/g, '&quot;') + '">' +
        '</div>';
    }).join('');

    _swal().fire({
      title: mode === 'bounced' ? 'Re-send after bounce' : 'Duplicate as a new request',
      html:
        '<div style="text-align:left">' +
        templateNote +
        (mode === 'bounced'
          ? '<div class="es-dialog-note">Fix the email address(es) below. The same tracking id is reused — ' +
            'to everyone involved this is still one document.</div>'
          : '<div class="es-dialog-note">The ' + esignEsc(row.status) + ' request stays on file; a NEW request ' +
            'with a new tracking id is created and sent.</div>') +
        '<div style="font-weight:bold;margin:6px 0 2px">Recipients (signing order top to bottom)</div>' +
        recipRows +
        '<div style="font-weight:bold;margin:10px 0 2px">Document PDF <span style="color:#dc2626">*</span></div>' +
        '<div class="es-dialog-note">The unsigned PDF is not stored server-side — re-attach it here.</div>' +
        '<input type="file" id="es-rs-file" accept="application/pdf" style="width:100%">' +
        '</div>',
      width: 560,
      showCancelButton: true,
      confirmButtonText: mode === 'bounced' ? 'Re-send' : 'Duplicate & send',
      showLoaderOnConfirm: true,
      allowOutsideClick: function () { return !_swal().isLoading(); },
      preConfirm: async function () {
        var names = Array.prototype.map.call(document.querySelectorAll('.es-rs-name'), function (el) { return el.value.trim(); });
        var emails = Array.prototype.map.call(document.querySelectorAll('.es-rs-email'), function (el) { return el.value.trim(); });
        var recips = names.map(function (n, i) { return { name: n, email: emails[i], order: i + 1 }; });
        var fileEl = document.getElementById('es-rs-file');
        if (!fileEl.files || !fileEl.files.length) {
          _swal().showValidationMessage('A PDF is required to re-send.');
          return false;
        }
        var fd = new FormData();
        fd.append('file', fileEl.files[0]);
        fd.append('recipients', JSON.stringify(recips));
        try {
          return await esignUpload('/api/esign/' + row.id + '/resend', fd);
        } catch (err) {
          _swal().showValidationMessage(err.message);
          return false;
        }
      },
    }).then(function (result) {
      if (result.isConfirmed && result.value) {
        var out = result.value;
        _toast('success',
          out.mode === 'duplicated' ? 'Duplicated and sent (new request #' + out.request.id + ')' : 'Re-sent',
          out.testing ? 'TEST MODE — watermarked, no credits spent' : undefined);
        if (onChange) onChange();
      }
    });
  }

  // ── MARK SATISFIED EXTERNALLY ──────────────────────────────
  function esignSatisfiedDialog(row, onChange) {
    _swal().fire({
      title: 'Mark satisfied outside e-sign',
      html:
        '<div style="text-align:left">' +
        '<div class="es-dialog-note">Use this when the client signed on paper (or by other means). ' +
        'Tracking on this request STOPS — the e-sign link is dead to us afterwards. ' +
        'If you attach the signed PDF it is filed to the case like a normal completion.</div>' +
        '<div style="font-weight:bold;margin:6px 0 2px">Note</div>' +
        '<textarea id="es-sat-note" style="width:100%;height:60px;resize:vertical;box-sizing:border-box" ' +
        'placeholder="e.g. Signed in office 7/19, original in file"></textarea>' +
        '<div style="font-weight:bold;margin:10px 0 2px">Signed PDF (optional)</div>' +
        '<input type="file" id="es-sat-file" accept="application/pdf" style="width:100%">' +
        '</div>',
      width: 540,
      showCancelButton: true,
      confirmButtonText: 'Mark satisfied',
      showLoaderOnConfirm: true,
      allowOutsideClick: function () { return !_swal().isLoading(); },
      preConfirm: async function () {
        var note = document.getElementById('es-sat-note').value.trim();
        var fileEl = document.getElementById('es-sat-file');
        var fd = new FormData();
        if (note) fd.append('note', note);
        if (fileEl.files && fileEl.files.length) fd.append('file', fileEl.files[0]);
        try {
          return await esignUpload('/api/esign/' + row.id + '/satisfied-external', fd);
        } catch (err) {
          _swal().showValidationMessage(err.message);
          return false;
        }
      },
    }).then(function (result) {
      if (result.isConfirmed && result.value) {
        var out = result.value;
        var warn = (out.warnings && out.warnings.length) ? out.warnings.join('; ') : undefined;
        _toast(warn ? 'warning' : 'success', 'Marked satisfied', warn);
        if (onChange) onChange();
      }
    });
  }

  // ── ACTION MENU ────────────────────────────────────────────
  // One entry point both surfaces call for a row's "Actions": a small Swal
  // listing only the operations legal for the row's status.
  function esignOpenActions(row, onChange) {
    var buttons = [];
    buttons.push({ label: 'Details & timeline', icon: 'fa-list', fn: function () { esignDetailDialog(row.id, onChange); } });
    if (esignCanRemind(row.status)) {
      buttons.push({ label: 'Nudge (remind all)', icon: 'fa-bell', fn: function () { esignRemindDialog(row, onChange); } });
    }
    if (esignCanRecall(row.status)) {
      buttons.push({ label: 'Recall', icon: 'fa-rotate-left', fn: function () { esignRecallDialog(row, onChange); } });
    }
    var rsMode = esignResendMode(row.status);
    if (rsMode) {
      buttons.push({
        label: rsMode === 'bounced' ? 'Re-send (fix email)' : 'Duplicate as new request',
        icon: 'fa-paper-plane', fn: function () { esignResendDialog(row, onChange); },
      });
    }
    if (esignCanSatisfy(row.status)) {
      buttons.push({ label: 'Mark satisfied externally', icon: 'fa-file-signature', fn: function () { esignSatisfiedDialog(row, onChange); } });
    }

    window.__esignMenuActions = buttons.map(function (b) { return b.fn; });
    _swal().fire({
      title: '<span style="font-size:16px">' + esignEsc(row.document_name || ('Request #' + row.id)) + '</span>',
      html: '<div style="margin-bottom:8px">' + esignChipHtml(row.status) + '</div>' +
        buttons.map(function (b, i) {
          return '<button class="swal2-styled" style="display:block;width:100%;margin:4px 0;background:#4a5568" ' +
            'onclick="Swal.close();window.__esignMenuActions[' + i + ']()">' +
            '<i class="fa-solid ' + b.icon + '"></i> ' + esignEsc(b.label) + '</button>';
        }).join(''),
      width: 380,
      showConfirmButton: false,
      showCloseButton: true,
    });
  }

  // ── expose ─────────────────────────────────────────────────
  window.esignApi             = esignApi;
  window.esignJwt             = esignJwt;
  window.esignUpload          = esignUpload;
  window.esignFetchPdf        = esignFetchPdf;
  window.esignChipHtml        = esignChipHtml;
  window.esignRecipientsHtml  = esignRecipientsHtml;
  window.esignDetailDialog    = esignDetailDialog;
  window.esignRemindDialog    = esignRemindDialog;
  window.esignRecallDialog    = esignRecallDialog;
  window.esignResendDialog    = esignResendDialog;
  window.esignSatisfiedDialog = esignSatisfiedDialog;
  window.esignOpenActions     = esignOpenActions;
})();