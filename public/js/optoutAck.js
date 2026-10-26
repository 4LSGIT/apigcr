// public/js/optoutAck.js
//
// Staff sends to an opted-out recipient WARN, they do not refuse (ruling
// 2026-10-27). The send routes (POST /api/phone-lines/:id/sms, POST
// /api/mail/send, /internal/{sms,mms,email}/send) answer 409 code 'opted_out'
// until the body carries acknowledge_optout:true; this turns that 409 into a
// confirm and, on OK, ONE resend of the same request with the acknowledgement
// added. Cancel → an Error (optoutDeclined:true) and nothing is sent.
//
// The server owns the rule (services/optoutService.js): a caller that never
// goes through here simply does not send to an opted-out recipient, so
// forgetting this helper fails safe. Ask Casey's send card deliberately does
// NOT use it — Casey refuses an opted-out recipient.
//
//   ycOptoutAck.send(apiSend, path, method, body[, headers[, opts]])
//     → whatever apiSend resolves to. `opts.confirm(text)` replaces
//       window.confirm (tests).
(function () {
  'use strict';

  function isOptoutRefusal(err) {
    return !!(err && err.status === 409 && err.body && err.body.code === 'opted_out');
  }

  function confirmText(body) {
    var msg = (body && body.message) || 'The recipient has opted out.';
    return msg + '\n\nSend anyway?';
  }

  async function send(apiSend, path, method, body, headers, opts) {
    // Pass exactly the caller's arguments through (no trailing undefined).
    var call = function (b) { return headers === undefined ? apiSend(path, method, b) : apiSend(path, method, b, headers); };
    try {
      return await call(body);
    } catch (err) {
      if (!isOptoutRefusal(err) || !body || typeof body !== 'object' || Array.isArray(body)) throw err;
      var ask = (opts && typeof opts.confirm === 'function') ? opts.confirm : function (t) { return window.confirm(t); };
      if (!ask(confirmText(err.body))) {
        var declined = new Error('Cancelled — nothing was sent (the recipient has opted out).');
        declined.optoutDeclined = true;
        throw declined;
      }
      var acked = Object.assign({}, body, { acknowledge_optout: true });
      return call(acked);
    }
  }

  window.ycOptoutAck = Object.freeze({ send: send, isOptoutRefusal: isOptoutRefusal, confirmText: confirmText });
})();
