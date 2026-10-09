/* public/js/mailRender.js — hostile mail HTML → a sandboxed srcdoc iframe.
 *
 * Mailbox-system arc, slice S2 (ref/MAILBOX_SYSTEM_DESIGN.md §4.4). Loaded by
 * public/comms.html AFTER /js/vendor/purify-3.4.16.min.js (DOMPurify, vendored
 * byte-identical from the npm tarball — tests/mailboxS2.render.test.js pins
 * its hash). Exposes window.YCMailRender.
 *
 * body_html is attacker-controlled input (anyone can email the firm) rendered
 * to staff on the app origin, where the staff JWT lives. It reaches the page
 * ONLY through createFrame(): THE ONE SINK is `iframe.srcdoc` below. Nothing
 * here (or in comms.html) writes mail content with innerHTML / outerHTML /
 * insertAdjacentHTML / document.write — the render suite greps for it.
 *
 * THREE INDEPENDENT LAYERS — each is mutation-tested to bite on its own:
 *   1. SANITIZE   DOMPurify (HTML profile only: no SVG/MathML), forms and
 *                 media dropped, every <a> forced to target=_blank +
 *                 rel=noopener noreferrer. Scripts, handlers and javascript:
 *                 URLs never survive.
 *   2. SANDBOX    the iframe carries SANDBOX below: NO allow-scripts, NO
 *                 allow-same-origin (an opaque origin with no script — it can
 *                 neither run code nor reach the parent or its storage), no
 *                 forms, no top navigation, no modals. allow-popups(+escape)
 *                 exists ONLY so a clicked link opens as a normal new tab —
 *                 without it the click would navigate the frame itself.
 *   3. CSP        the srcdoc's first head element is a CSP <meta>:
 *                 default-src 'none'; images only from data: (blocked mode);
 *                 no fonts / media / frames / form targets from anywhere.
 *
 * REMOTE CONTENT IS BLOCKED BY DEFAULT (privacy: a tracking pixel is a read
 * receipt to whoever sent it — opposing counsel included). Layer 1 strips
 * remote URLs from src / srcset / background / poster and from CSS url() /
 * image-set() / @import (style attributes AND <style> elements), counting what
 * it removed; layer 3 enforces the same in the engine if anything slipped
 * through. `allowRemote: true` (the "Show images" button) re-renders with
 * http(s) images allowed — layers 1-2 unchanged, CSP img-src widened.
 * cid: inline images resolve only through `cidMap` (cid → data: URL the
 * caller fetched through the grant-checked part route); unresolved ones are
 * removed and counted as `inline`.
 *
 * No script runs inside the frame, so the parent cannot measure it: height
 * is ESTIMATED from what the sanitizer walked (text length, blocks, images)
 * and the frame scrolls when the estimate is short.
 */
(function (root) {
  'use strict';

  var SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

  // Tokens that would undo layer 2. createFrame refuses to render if
  // SANDBOX ever grows one of them (belt and braces for future edits).
  var FORBIDDEN_SANDBOX = ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-modals',
    'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-top-navigation-to-custom-protocols',
    'allow-pointer-lock', 'allow-presentation', 'allow-downloads', 'allow-storage-access-by-user-activation'];

  var CSP_BLOCKED = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
    "media-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'";
  var CSP_REMOTE = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; font-src data:; " +
    "media-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'";

  // Dropped outright: form controls (inert under the sandbox anyway — and a
  // phishing surface), media players (remote loads), document-level tags.
  var FORBID_TAGS = ['form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'datalist',
    'output', 'audio', 'video', 'source', 'track', 'object', 'embed', 'iframe', 'frame', 'frameset',
    'base', 'meta', 'link', 'dialog', 'template', 'portal'];
  var FORBID_ATTR = ['action', 'formaction', 'ping', 'srcdoc'];

  // Attributes whose value the ENGINE LOADS (vs href, which it navigates to).
  var LOAD_ATTRS = ['src', 'background', 'poster', 'lowsrc', 'dynsrc'];
  // In-page '#frag' links are dropped too: a srcdoc's base URL is the PARENT
  // page, so '#x' would navigate the frame to the app's own URL.
  var SAFE_HREF = /^\s*(https?:|mailto:|tel:|\/\/)/i;

  // The frame document's own base styles (inside the sandbox).
  var FRAME_CSS = 'html,body{margin:0;padding:0;background:#fff;color:#222;}' +
    'body{padding:10px 12px;font:14px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
    'overflow-wrap:anywhere;word-break:break-word;}' +
    'img{max-width:100%;height:auto;}table{max-width:100%;}pre{white-space:pre-wrap;}' +
    'img[data-yc-blocked]{display:inline-block;min-width:16px;min-height:16px;outline:1px dashed #bbb;}' +
    'blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;}';

  function purifier() {
    var DP = root.DOMPurify;
    if (!DP || typeof DP !== 'function') throw new Error('DOMPurify is not loaded');
    // A private instance: these hooks never leak into another caller.
    return DP(root);
  }

  /** data: URLs are self-contained; a fragment or empty value loads nothing. */
  function isInert(url) {
    var u = String(url == null ? '' : url).trim().toLowerCase();
    return !u || u.charAt(0) === '#' || u.indexOf('data:') === 0;
  }
  function isCid(url) { return /^\s*cid:/i.test(String(url == null ? '' : url)); }
  function isHttp(url) { return /^\s*(https?:)?\/\//i.test(String(url == null ? '' : url)); }

  /** RFC 2392: a cid: URL is the URL-encoded Content-ID (stored bare, see imapTransport). */
  function cidKey(url) {
    var k = String(url).replace(/^\s*cid:/i, '').trim();
    try { k = decodeURIComponent(k); } catch (_) { /* keep as written */ }
    return k.replace(/^<|>$/g, '').toLowerCase();
  }

  /**
   * CSS text with remote loads removed when blocking. @import is always
   * removed (a remote stylesheet is a remote load and a styling channel).
   */
  function scrubCss(css, allowRemote, counter) {
    var out = String(css == null ? '' : css);
    out = out.replace(/@import\b[^;]*;?/gi, function () { counter.remote++; return ''; });
    out = out.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, function (m, q, url) {
      if (isInert(url)) return m;
      if (allowRemote && isHttp(url)) return m;
      if (isCid(url)) { counter.inline++; return 'none'; }
      counter.remote++;
      return 'none';
    });
    // image-set() / -webkit-image-set() take bare strings as URLs.
    out = out.replace(/(-webkit-)?image-set\(([^)]*)\)/gi, function (m, w, inner) {
      if (allowRemote) return m;
      if (!/['"]\s*(https?:)?\/\//i.test(inner) && !/['"]\s*cid:/i.test(inner)) return m;
      counter.remote++;
      return 'none';
    });
    // Any url( the pattern above could not parse (a ')' inside quotes, …):
    // turn the function into an unknown one so the declaration is dropped.
    // CSS escapes (\75 rl( spelled url) are not chased here — layer 3 (CSP)
    // is what stops those.
    if (!allowRemote) {
      out = out.replace(/url\((?!\s*['"]?\s*data:)/gi, function () { counter.remote++; return 'yc-blocked('; });
    }
    return out;
  }

  /**
   * Sanitize one message's HTML.
   * @param {string} html
   * @param {{allowRemote?:boolean, cidMap?:Object<string,string>}} [opts]
   * @returns {{html:string, blocked:{remote:number, inline:number}, stats:{text:number, blocks:number, images:number}}}
   */
  function sanitize(html, opts) {
    opts = opts || {};
    var allowRemote = !!opts.allowRemote;
    var cidMap = opts.cidMap || {};
    var blocked = { remote: 0, inline: 0 };
    var stats = { text: 0, blocks: 0, images: 0 };
    var purify = purifier();

    purify.addHook('uponSanitizeElement', function (node, data) {
      var tag = data && data.tagName;
      if (tag === '#text') { stats.text += (node.nodeValue || '').length; return; }
      if (tag === 'style' && node.textContent) node.textContent = scrubCss(node.textContent, allowRemote, blocked);
      if (/^(p|div|tr|li|br|h[1-6]|blockquote|pre|table|hr)$/.test(tag || '')) stats.blocks++;
      if (tag === 'img') stats.images++;
    });

    purify.addHook('afterSanitizeAttributes', function (node) {
      if (!node || !node.getAttribute) return;
      var i;
      for (i = 0; i < LOAD_ATTRS.length; i++) {
        var a = LOAD_ATTRS[i];
        if (!node.hasAttribute(a)) continue;
        var v = node.getAttribute(a);
        if (isInert(v)) continue;
        if (isCid(v)) {
          var hit = cidMap[cidKey(v)];
          if (hit && /^data:image\//i.test(hit)) { node.setAttribute(a, hit); continue; }
          node.removeAttribute(a);
          node.setAttribute('data-yc-blocked', 'inline');
          blocked.inline++;
          continue;
        }
        if (allowRemote && isHttp(v)) continue;
        node.removeAttribute(a);
        node.setAttribute('data-yc-blocked', 'remote');
        blocked.remote++;
      }
      if (node.hasAttribute('srcset')) {
        var parts = String(node.getAttribute('srcset')).split(',');
        var keep = allowRemote && parts.every(function (p) { var u = p.trim().split(/\s+/)[0]; return isInert(u) || isHttp(u); });
        if (!keep && parts.some(function (p) { return !isInert(p.trim().split(/\s+/)[0]); })) {
          node.removeAttribute('srcset');
          blocked.remote++;
        }
      }
      if (node.hasAttribute('style')) {
        node.setAttribute('style', scrubCss(node.getAttribute('style'), allowRemote, blocked));
      }
      if (node.nodeName === 'A' || node.nodeName === 'AREA') {
        // Absolute web / mail / phone links only. A relative href would
        // resolve against the APP's URL (a srcdoc document's base).
        if (node.hasAttribute('href') && !SAFE_HREF.test(node.getAttribute('href'))) node.removeAttribute('href');
        if (node.hasAttribute('href')) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        } else {
          node.removeAttribute('target');
        }
      }
    });

    var clean;
    try {
      clean = purify.sanitize(String(html == null ? '' : html), {
        USE_PROFILES: { html: true },
        WHOLE_DOCUMENT: true,
        FORBID_TAGS: FORBID_TAGS,
        FORBID_ATTR: FORBID_ATTR,
        ALLOW_DATA_ATTR: false,
      });
    } finally {
      purify.removeAllHooks();
    }
    return { html: String(clean), blocked: blocked, stats: stats };
  }

  function escText(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** The full srcdoc document. CSP <meta> is the FIRST element of <head>. */
  function buildSrcdoc(bodyMarkup, opts) {
    opts = opts || {};
    return '<!DOCTYPE html><html><head>' +
      '<meta http-equiv="Content-Security-Policy" content="' + (opts.allowRemote ? CSP_REMOTE : CSP_BLOCKED) + '">' +
      '<meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
      '<style>' + FRAME_CSS + '</style></head><body>' + bodyMarkup + '</body></html>';
  }

  function estimateHeight(stats) {
    var est = Math.ceil((stats.text || 0) / 85) * 20 + (stats.blocks || 0) * 9 + (stats.images || 0) * 40 + 44;
    return Math.max(120, Math.min(est, 1400));
  }

  function assertSandbox(s) {
    var toks = String(s).toLowerCase().split(/\s+/);
    for (var i = 0; i < FORBIDDEN_SANDBOX.length; i++) {
      if (toks.indexOf(FORBIDDEN_SANDBOX[i]) !== -1) throw new Error('mail frame sandbox must not contain ' + FORBIDDEN_SANDBOX[i]);
    }
  }

  /**
   * Build (not insert) the frame for one message.
   * @param {Document} doc     the PARENT document (only used to create the element)
   * @param {{body_html?:string|null, body_text?:string|null}} msg
   * @param {{mode?:'html'|'text', allowRemote?:boolean, cidMap?:Object, title?:string}} [opts]
   * @returns {{frame:HTMLIFrameElement, blocked:{remote:number,inline:number}, mode:'html'|'text', height:number}}
   */
  function createFrame(doc, msg, opts) {
    opts = opts || {};
    var hasHtml = msg && msg.body_html != null && String(msg.body_html).trim() !== '';
    var mode = opts.mode === 'text' || !hasHtml ? 'text' : 'html';
    var markup;
    var blocked = { remote: 0, inline: 0 };
    var stats;
    if (mode === 'html') {
      var s = sanitize(msg.body_html, { allowRemote: !!opts.allowRemote, cidMap: opts.cidMap });
      markup = s.html;
      blocked = s.blocked;
      stats = s.stats;
    } else {
      var t = String((msg && msg.body_text) || '');
      markup = '<pre>' + escText(t) + '</pre>';
      stats = { text: t.length, blocks: (t.match(/\n/g) || []).length, images: 0 };
    }
    assertSandbox(SANDBOX);
    var frame = doc.createElement('iframe');
    // Sandbox FIRST, srcdoc second, insertion by the caller last: the frame
    // never loads a document without its sandbox.
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', opts.title || 'Message body');
    frame.className = 'mail-frame';
    var height = estimateHeight(stats);
    frame.style.height = height + 'px';
    frame.srcdoc = buildSrcdoc(markup, { allowRemote: !!opts.allowRemote && mode === 'html' });
    return { frame: frame, blocked: blocked, mode: mode, height: height };
  }

  root.YCMailRender = {
    sanitize: sanitize,
    buildSrcdoc: buildSrcdoc,
    createFrame: createFrame,
    estimateHeight: estimateHeight,
    scrubCss: scrubCss,
    SANDBOX: SANDBOX,
    FORBIDDEN_SANDBOX: FORBIDDEN_SANDBOX,
    CSP_BLOCKED: CSP_BLOCKED,
    CSP_REMOTE: CSP_REMOTE,
  };
})(window);
