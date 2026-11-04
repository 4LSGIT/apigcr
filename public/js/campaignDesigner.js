// public/js/campaignDesigner.js
//
// YisraMail C3b — the campaign "Designer" editor mode (GrapesJS + MJML).
// ref/YISRAMAIL_DESIGN.md §6.3 "As built (C3b)"; spec: the C3 spike findings
// (local/2026-11-03_YISRAMAIL_C3_SPIKE_FINDINGS.md, cited below as "findings").
//
// A plain global (window.YcDesigner) — no module system, like assetpicker.js.
// The same file is require()-able from Node so the pure helpers (text
// derivation, export checks, payloads, rejection messages) are unit-tested
// without a browser; everything that needs GrapesJS runs only in a browser.
//
// THIS FILE NEVER LOADS GRAPESJS BY ITSELF. loadLibs() injects the pinned,
// SRI-checked CDN files (~650 KB gz) the first time the user picks Designer —
// a plain compose page never fetches them (findings "Pinned versions",
// "Conditions for proceed" 5).
//
// The editor is NOT a security boundary. The server validates every save
// (C3a, findings rules 1–10) and C2 asserts the footer after rendering; this
// file's job is that normal use never PRODUCES a design the server refuses,
// and that the canvas cannot run stored markup (findings Q4, Mitigation A).

(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YcDesigner = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  // ── Pinned libraries (findings "Pinned versions") ─────────────────────
  // Exact versions, sha384 of the bytes the spike tested. A changed byte on
  // the CDN fails the integrity check and the designer refuses to load.
  // grapesjs-mjml 1.1.x (unbundled mjml, targets 0.23.x) is the revisit —
  // ref/plans.md.
  var LIBS = Object.freeze({
    css: Object.freeze({
      href: 'https://cdn.jsdelivr.net/npm/grapesjs@0.23.8/dist/css/grapes.min.css',
      integrity: 'sha384-ipHR7uZK8wuUZWD8zZ09XYemZDqShtJpYjZibAX8L1f5rAUb4W78/j43sKG32Ip4',
    }),
    scripts: Object.freeze([
      Object.freeze({
        src: 'https://cdn.jsdelivr.net/npm/grapesjs@0.23.8/dist/grapes.min.js',
        integrity: 'sha384-TKFOGgR9J4dEbVZg+n/JLhw8KtA6TLRGeBjxCNQg3hxN5BR3Vz7gEJitzEWKgELK',
      }),
      Object.freeze({
        src: 'https://cdn.jsdelivr.net/npm/grapesjs-mjml@1.0.8/dist/index.js',
        integrity: 'sha384-Hu3AC9+4h23WQ4NmDvVQ5C8C2H5K18m9NUdiDGZrAs5cjiLHzLbxbsvl+BwqXHHH',
      }),
    ]),
  });
  var LOAD_TIMEOUT_MS = 30000;

  // ── The footer slot (C2's contract: campaignService.FOOTER_SLOT) ───────
  // C2 injects the compliance footer AT this marker. The locked footer block
  // holds the marker and NOTHING else — a visible placeholder line would go
  // out to recipients, because C2 injects at the marker and deletes nothing
  // around it (Fred's A/B eyeball, 2026-11-04).
  var FOOTER_SLOT = '<!-- yc:footer-slot -->';
  var FOOTER_SLOT_CONTENT = ' yc:footer-slot ';   // the comment component's content
  var FOOTER_CLASS = 'yc-footer';
  var FOOTER_INNER_MJML = '<mj-column><mj-text padding="0 25px">' + FOOTER_SLOT + '</mj-text></mj-column>';
  var FOOTER_SECTION_MJML = '<mj-section css-class="' + FOOTER_CLASS + '" background-color="#ffffff" padding="0 16px 16px">' + FOOTER_INNER_MJML + '</mj-section>';

  // ── Canvas hardening (findings Q4 "Mitigation A, chosen") ──────────────
  // A CSP written into the canvas document: stored component attributes,
  // `content` and `script` render straight into a same-origin frame that can
  // reach parent.apiSend, and this policy is what stops them running. The
  // <meta> does not survive GrapesJS rewriting the head, but the policy holds
  // for the document's life — so the test asserts BEHAVIOUR, never the element.
  var CANVAS_FRAME_CONTENT = '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'; frame-src \'none\'; child-src \'none\'; base-uri \'none\'; form-action \'none\'"></head><body></body></html>';

  // ── Blocks (findings Q3): the plugin's set cut to these (no mj-raw — raw
  // HTML runs in the canvas, payload P6), plus our Header block. The footer
  // slot is NOT a block: it is inserted, locked and pinned last by us.
  var BLOCKS = Object.freeze(['mj-1-column', 'mj-2-columns', 'mj-text', 'mj-button', 'mj-image', 'mj-divider', 'mj-spacer']);

  // ── The footer lock (findings Q5 "Setup" + "Not blocked" 5 and 6) ──────
  // stylable is a list naming NO real property rather than the spike's
  // `false`: the same effect (the Style Manager shows nothing), but
  // grapesjs-mjml 1.0.8's mj-column view calls stylable.indexOf() when it
  // re-renders and throws on `false`. An empty list measures the same (0
  // properties); the named list just says what it is for.
  var NOTHING_STYLABLE = 'yc-locked-footer';
  var FOOTER_FLAGS = Object.freeze({ removable: false, draggable: false, droppable: false, copyable: false, editable: false, stylable: Object.freeze([NOTHING_STYLABLE]) });
  var SELECT_PARENT_ICON = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M15 14l-5-5-5 5h3v6h4v-6z"/></svg>';
  function footerToolbar() {
    // select-parent ONLY: the default toolbar (move / clone / delete) is
    // built before the flags are set, so it would still show (Q5 item 5).
    return [{ label: SELECT_PARENT_ICON, command: 'core:component-exit', attributes: { title: 'Select parent' } }];
  }

  // Commands replaced by a refusal (Q5 items 1 and 3): the stock MJML import
  // replaces the whole design, footer included; canvas-clear empties it.
  var REFUSED_COMMANDS = Object.freeze(['mjml-import', 'core:canvas-clear']);

  // Display-only preview of the compliance footer. It lives ONLY in the
  // canvas DOM (a view element standing in for the marker comment) — never in
  // the model, so getProjectData() / getHtml() / the compiled html carry the
  // marker and nothing else. Static sample text styled like the real footer
  // (lib/complianceFooter.js); the real one, with the firm's values, is what
  // "Send test to me" shows.
  var PREVIEW_ATTR = 'data-yc-footer-preview';
  var PREVIEW_LINES = Object.freeze([
    { text: 'Compliance footer preview — added here when the email is sent', strong: true },
    { text: 'ADVERTISEMENT (marketing topics without opt-in)' },
    { text: 'You’re receiving this [topic] email from [firm name]. Unsubscribe: [link] · Manage preferences' },
    { text: '[Firm name] · [postal address] · [phone]' },
    { text: 'Responsible attorney: [name]' },
    { text: 'We are a debt relief agency. We help people file for bankruptcy relief under the Bankruptcy Code.' },
  ]);

  // ── small helpers ─────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function countOf(hay, needle) {
    var n = 0;
    for (var i = String(hay).indexOf(needle); i !== -1; i = String(hay).indexOf(needle, i + needle.length)) n++;
    return n;
  }
  function originOf(win) {
    try { return (win && win.location && win.location.origin) || 'https://app.4lsg.com'; } catch (_) { return 'https://app.4lsg.com'; }
  }

  // ── Lazy loading (SRI) ────────────────────────────────────────────────
  var libsPromise = null;

  function injectStylesheet(doc) {
    if (doc.querySelector('link[data-yc-designer]')) return;
    var l = doc.createElement('link');
    l.rel = 'stylesheet';
    l.setAttribute('integrity', LIBS.css.integrity);   // before href: the fetch must carry the check
    l.setAttribute('crossorigin', 'anonymous');
    l.setAttribute('referrerpolicy', 'no-referrer');
    l.href = LIBS.css.href;
    l.setAttribute('data-yc-designer', 'css');
    doc.head.appendChild(l);
  }

  function injectScript(doc, spec) {
    return new Promise(function (resolve, reject) {
      var s = doc.createElement('script');
      var timer = setTimeout(function () { reject(new Error('Timed out loading ' + spec.src)); }, LOAD_TIMEOUT_MS);
      s.setAttribute('integrity', spec.integrity);
      s.setAttribute('crossorigin', 'anonymous');
      s.setAttribute('referrerpolicy', 'no-referrer');
      s.async = false;
      s.src = spec.src;
      s.setAttribute('data-yc-designer', 'js');
      s.onload = function () { clearTimeout(timer); resolve(); };
      // An integrity mismatch lands here too (the browser refuses the bytes).
      s.onerror = function () { clearTimeout(timer); reject(new Error('Could not load ' + spec.src + ' (network, or the file failed its integrity check)')); };
      doc.head.appendChild(s);
    });
  }

  /**
   * Inject the pinned CSS + scripts (sequentially: the plugin needs grapesjs)
   * and resolve { grapesjs, plugin }. Memoized; a failure clears the memo so
   * the user can retry.
   */
  function loadLibs(win) {
    win = win || root;
    if (libsPromise) return libsPromise;
    var doc = win.document;
    libsPromise = (async function () {
      injectStylesheet(doc);
      for (var i = 0; i < LIBS.scripts.length; i++) await injectScript(doc, LIBS.scripts[i]);
      var gjs = win.grapesjs;
      var plugin = win['grapesjs-mjml'];
      plugin = (plugin && plugin.default) || plugin;
      if (!gjs || typeof gjs.init !== 'function' || typeof plugin !== 'function') {
        throw new Error('The designer libraries loaded but did not register');
      }
      return { grapesjs: gjs, plugin: plugin };
    })();
    libsPromise.catch(function () { libsPromise = null; });
    return libsPromise;
  }

  // ── Templates ─────────────────────────────────────────────────────────
  function headerMjml(origin) {
    return '<mj-section background-color="#1e3a5f" padding="20px 0"><mj-column>'
      + '<mj-image src="' + esc(origin) + '/assets/icon-512.png" width="96px" alt="Logo"></mj-image>'
      + '<mj-text align="center" color="#ffffff" font-size="22px" font-weight="bold">Newsletter title</mj-text>'
      + '</mj-column></mj-section>';
  }

  /**
   * The starter newsletter (findings Q3; adapted from the spike's
   * out/newsletter.mjml). Its footer section holds ONLY the marker.
   */
  function starterMjml(origin) {
    var img = esc(origin) + '/assets/icon-512.png';
    return '<mjml><mj-head>'
      + '<mj-title>Newsletter</mj-title>'
      + '<mj-preview>Your monthly update, {{contacts.contact_fname|cap}}</mj-preview>'
      + '<mj-attributes><mj-all font-family="Arial, Helvetica, sans-serif"></mj-all><mj-text font-size="15px" line-height="1.5" color="#1f2937"></mj-text></mj-attributes>'
      + '</mj-head><mj-body background-color="#f3f4f6">'
      + '<mj-section background-color="#1e3a5f" padding="20px 0"><mj-column>'
      + '<mj-image src="' + img + '" width="96px" alt="Logo"></mj-image>'
      + '<mj-text align="center" color="#ffffff" font-size="22px" font-weight="bold">Monthly Newsletter</mj-text>'
      + '</mj-column></mj-section>'
      + '<mj-section background-color="#ffffff" padding="24px 16px 8px"><mj-column>'
      + '<mj-text>Hi {{contacts.contact_fname|cap}},</mj-text>'
      + '<mj-text>Double-click any text to edit it. Drag blocks in from the Blocks panel; double-click an image to replace it.</mj-text>'
      + '</mj-column></mj-section>'
      + '<mj-section background-color="#ffffff" padding="0 16px"><mj-column width="50%">'
      + '<mj-image src="' + img + '" width="180px" alt="Left column image"></mj-image>'
      + '<mj-text font-weight="bold" font-size="17px">Left column</mj-text>'
      + '<mj-text>Two columns side by side on a computer; they stack on a phone.</mj-text>'
      + '</mj-column><mj-column width="50%">'
      + '<mj-image src="' + img + '" width="180px" alt="Right column image"></mj-image>'
      + '<mj-text font-weight="bold" font-size="17px">Right column</mj-text>'
      + '<mj-text>Second column text.</mj-text>'
      + '</mj-column></mj-section>'
      + '<mj-section background-color="#ffffff" padding="8px 16px 24px"><mj-column>'
      + '<mj-button background-color="#c2410c" color="#ffffff" font-size="16px" border-radius="6px" href="https://4lsg.com/b/your-booking-slug?c={{contacts.contact_token}}">Book a free consultation</mj-button>'
      + '<mj-divider border-color="#d1d5db" border-width="1px"></mj-divider>'
      + '<mj-text font-size="13px" color="#6b7280">Questions? Reply to this email.</mj-text>'
      + '</mj-column></mj-section>'
      + FOOTER_SECTION_MJML
      + '</mj-body></mjml>';
  }

  // ── Merge tags: the ONE list is campaign.html's #c-placeholder-email ───
  /** <select> → [{ value, label, group }] (the empty "Insert placeholder…" option skipped). */
  function placeholdersFrom(selectEl) {
    var out = [];
    if (!selectEl) return out;
    var opts = selectEl.querySelectorAll('option');
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      if (!o.value) continue;
      var g = o.parentNode && o.parentNode.tagName && o.parentNode.tagName.toLowerCase() === 'optgroup' ? o.parentNode.getAttribute('label') : null;
      out.push({ value: o.value, label: o.textContent.trim(), group: g });
    }
    return out;
  }

  function tagSelectHtml(placeholders, cls, firstLabel) {
    var html = '<select class="' + esc(cls) + '" title="Insert a merge tag"><option value="">' + esc(firstLabel) + '</option>';
    var group = null;
    for (var i = 0; i < placeholders.length; i++) {
      var p = placeholders[i];
      if (p.group !== group) {
        if (group) html += '</optgroup>';
        if (p.group) html += '<optgroup label="' + esc(p.group) + '">';
        group = p.group;
      }
      html += '<option value="' + esc(p.value) + '">' + esc(p.label) + '</option>';
    }
    if (group) html += '</optgroup>';
    return html + '</select>';
  }

  // ── Footer: find / normalize / lock / pin ─────────────────────────────
  function isFooterSection(c) {
    if (!c || c.get('type') !== 'mj-section') return false;
    var cls = String((c.getAttributes() || {})['css-class'] || '');
    return cls.split(/\s+/).indexOf(FOOTER_CLASS) !== -1;
  }
  function findBody(editor) { var w = editor.getWrapper(); return (w && w.findType('mj-body')[0]) || null; }
  function findFooters(editor) { var w = editor.getWrapper(); return w ? w.findType('mj-section').filter(isFooterSection) : []; }
  function findFooter(editor) { var f = findFooters(editor); return f.length ? f[f.length - 1] : null; }
  function isSlotMarker(model) {
    return !!model && model.get('type') === 'comment' && String(model.get('content') || '').trim() === FOOTER_SLOT_CONTENT.trim();
  }

  function lockTree(c) {
    c.set({ removable: FOOTER_FLAGS.removable, draggable: FOOTER_FLAGS.draggable, droppable: FOOTER_FLAGS.droppable,
      copyable: FOOTER_FLAGS.copyable, editable: FOOTER_FLAGS.editable, stylable: [NOTHING_STYLABLE] });
    c.set('toolbar', footerToolbar());
    c.set('traits', []);
    c.components().forEach(lockTree);
  }

  /**
   * After every load: exactly one footer section, holding ONLY the marker
   * (canonical content — whatever a stored design carried there is replaced),
   * locked (flags + select-parent toolbar + no traits), last child of
   * mj-body. → { repaired } — true when the design had to be changed.
   */
  function normalizeFooter(editor) {
    var body = findBody(editor);
    if (!body) throw new Error('This design has no email body (mj-body)');
    var repaired = false;
    var footers = findFooters(editor);
    var footer = footers.length ? footers[footers.length - 1] : null;
    for (var i = 0; i < footers.length - 1; i++) { footers[i].remove(); repaired = true; }
    if (!footer) { footer = body.append(FOOTER_SECTION_MJML)[0]; repaired = true; }
    var inner = footer.components();
    var canonical = inner.length === 1 && inner.at(0).get('type') === 'mj-column'
      && inner.at(0).components().length === 1 && inner.at(0).components().at(0).get('type') === 'mj-text'
      && inner.at(0).components().at(0).components().length === 1
      && isSlotMarker(inner.at(0).components().at(0).components().at(0));
    if (!canonical) { footer.components(FOOTER_INNER_MJML); repaired = true; }
    var comps = body.components();
    if (footer.parent() !== body || comps.indexOf(footer) !== comps.length - 1) {
      footer.move(body, { at: body.components().length });
      repaired = true;
    }
    lockTree(footer);
    return { repaired: repaired };
  }

  /** Q5 item 4: anything that lands below the footer is moved back above it. */
  function repinFooter(editor) {
    var body = findBody(editor);
    var footer = findFooter(editor);
    if (!body || !footer || footer.parent() !== body) return false;
    var comps = body.components();
    if (comps.indexOf(footer) === comps.length - 1) return false;
    footer.move(body, { at: comps.length });
    return true;
  }

  // ── Editor construction ───────────────────────────────────────────────
  function installTypes(editor, ctx) {
    var Comp = editor.Components;

    // 1. The marker comment renders as the footer PREVIEW in the canvas only.
    var commentView = Comp.getType('comment').view.prototype;
    var baseCreate = commentView._createElement;
    var baseRender = commentView.render;
    Comp.addType('comment', {
      view: {
        _createElement: function () {
          if (!isSlotMarker(this.model)) return baseCreate.apply(this, arguments);
          var d = document.createElement('div');
          d.setAttribute(PREVIEW_ATTR, '1');
          d.setAttribute('contenteditable', 'false');
          d.setAttribute('style', 'margin:8px 0 0;padding:12px 0 0;border-top:1px dashed #9ca3af;pointer-events:none;user-select:none;');
          for (var i = 0; i < PREVIEW_LINES.length; i++) {
            var p = document.createElement('p');
            p.setAttribute('style', 'margin:0 0 6px;font-size:12px;line-height:1.5;color:#6b7280;font-family:Arial,Helvetica,sans-serif;' + (PREVIEW_LINES[i].strong ? 'font-weight:700;color:#374151;' : ''));
            p.textContent = PREVIEW_LINES[i].text;
            d.appendChild(p);
          }
          return d;
        },
        render: function () {
          if (isSlotMarker(this.model)) return this;   // the preview is built; never write the content into it
          return baseRender.apply(this, arguments);
        },
      },
    });

    // 2. mj-body refuses a drop BELOW the footer (Q5 item 4, at drag time).
    var bodyType = Comp.getType('mj-body');
    var origDroppable = bodyType && bodyType.model.prototype.defaults.droppable;
    Comp.addType('mj-body', {
      model: {
        defaults: {
          droppable: function (src, target, index) {
            var footer = findFooter(editor);
            if (footer && src !== footer && index != null) {
              var fi = target.components().indexOf(footer);
              if (fi !== -1 && index > fi) return false;
            }
            var d = origDroppable;
            if (typeof d === 'function') return !!d(src, target, index);
            if (Array.isArray(d)) d = d.join(',');
            if (typeof d === 'string') { var el = src && src.getEl && src.getEl(); return !!(el && el.matches && el.matches(d)); }
            return d !== false;
          },
        },
      },
    });

    // 3. href traits get the merge-tag helper (findings Q3 picker). No type
    //    has a src trait: image addresses come from the AssetPicker only.
    editor.TraitManager.addType('yc-url', {
      createInput: function (o) {
        var wrap = document.createElement('div');
        wrap.className = 'yc-url-trait';
        wrap.innerHTML = '<input type="text" class="yc-url-input" placeholder="https://…">' + tagSelectHtml(ctx.placeholders, 'yc-url-tags', '{{ }} Insert merge tag');
        var input = wrap.querySelector('input');
        var sel = wrap.querySelector('select');
        sel.addEventListener('change', function () {
          var v = sel.value;
          sel.value = '';
          if (!v) return;
          var start = input.selectionStart == null ? input.value.length : input.selectionStart;
          var end = input.selectionEnd == null ? start : input.selectionEnd;
          var next = input.value.slice(0, start) + v + input.value.slice(end);
          if (urlProblem(next) && !urlProblem(input.value)) {
            // a contact tag at the START of an address is refused by the server
            // (a contact-controlled value could become javascript:…)
            if (ctx.notify) ctx.notify('An address must start with https:// (or mailto: / tel:) — put the merge tag after it.', 'warning');
            return;
          }
          input.value = next;
          // the change event this listener runs inside bubbles on to the trait
          // view, whose onEvent below reads the input — no second dispatch.
        });
        return wrap;
      },
      onEvent: function (o) {
        var v = o.elInput.querySelector('input').value;
        var attrs = {};
        attrs[o.trait.getName()] = v;
        o.component.addAttributes(attrs);
      },
      onUpdate: function (o) {
        var a = o.component.getAttributes() || {};
        o.elInput.querySelector('input').value = a[o.trait.getName()] || '';
      },
    });
    ['mj-button', 'mj-image', 'link'].forEach(function (t) {
      var type = Comp.getType(t);
      if (!type) return;
      var traits = type.model.prototype.defaults.traits;
      if (!Array.isArray(traits)) return;
      var mapped = traits.map(function (tr) {
        var name = typeof tr === 'string' ? tr : tr && tr.name;
        if (name !== 'href') return tr;
        var base = typeof tr === 'string' ? { name: tr } : tr;
        var out = {};
        for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
        out.type = 'yc-url';
        out.label = out.label || 'Link';
        return out;
      });
      Comp.addType(t, { model: { defaults: { traits: mapped } } });
    });
  }

  function installCommands(editor, ctx) {
    // Q5 items 1 + 3: the import and canvas-clear commands refuse.
    REFUSED_COMMANDS.forEach(function (id) {
      editor.Commands.add(id, {
        run: function () {
          if (ctx.notify) ctx.notify('That action is turned off in the designer — it would remove the locked footer.', 'info');
          return false;
        },
      });
    });
    var importBtn = editor.Panels.getButton('options', 'mjml-import');
    if (importBtn) editor.Panels.removeButton('options', 'mjml-import');

    // Images: every image flow goes to the shared AssetPicker — never the
    // GrapesJS asset manager, never base64 (the asset store is the home).
    // Registered as a bare function: with a `stop` member GrapesJS treats the
    // command as STATEFUL — after one run it stays active and every later
    // runCommand (each image double-click) is silently a no-op, so the picker
    // opened exactly once per editor (Fred's hand-check, 2026-11-04). A
    // function-form command is stateless and re-runs every time.
    editor.Commands.add('open-assets', function (ed, sender, opts) {
      opts = opts || {};
      var target = opts.target || ed.getSelected();
      Promise.resolve(ctx.pickImage ? ctx.pickImage() : null).then(function (url) {
        if (!url) return;
        if (!/^https?:\/\//i.test(String(url))) {
          if (ctx.notify) ctx.notify('Images must come from the asset library (an http(s) address).', 'warning');
          return;
        }
        if (target && target.get && target.get('type') === 'mj-image') {
          target.addAttributes({ src: url });
          target.set('src', url);
        } else if (typeof opts.select === 'function') {
          var asset = ed.AssetManager.add({ src: url });
          opts.select(Array.isArray(asset) ? asset[0] : asset, true);
        } else if (target && target.get && target.get('type') === 'image') {
          target.set('src', url);
        }
      }).catch(function (err) {
        if (ctx.notify) ctx.notify((err && err.message) || 'Image picker failed', 'error');
      });
    });
  }

  /**
   * GrapesJS's insertHTML leaves the inserted text SELECTED, so the next
   * keystroke would overwrite the tag just inserted — put the caret after it.
   */
  function caretAfterInsert(editor) {
    try {
      var sel = editor.Canvas.getDocument().getSelection();
      if (sel && sel.rangeCount) sel.collapseToEnd();
    } catch (_) { /* nothing selected */ }
  }

  // The stock RTE actions that stay: bold <b>, italic <i>, underline <u>, link
  // <a>, wrap-for-style (a span component) — all inside the server's allowed
  // inline set. Strike-through is REMOVED: Chrome's execCommand writes
  // <strike>, which the server refuses (rule 2 allows <s>), so one click would
  // poison every later save with a 400 (C3b review, ruling 2026-11-04).
  var REMOVED_RTE_ACTIONS = Object.freeze(['strikethrough']);

  function installRte(editor, ctx) {
    REMOVED_RTE_ACTIONS.forEach(function (name) { editor.RichTextEditor.remove(name); });
    // Merge-tag picker in the text toolbar — insertHTML (findings Q1/Q3).
    editor.RichTextEditor.add('yc-merge-tag', {
      icon: tagSelectHtml(ctx.placeholders, 'yc-rte-merge', '{{ }}'),
      attributes: { title: 'Insert merge tag', class: 'gjs-rte-action yc-rte-merge-wrap' },
      event: 'change',
      result: function (rte, action) {
        var sel = action.btn.querySelector('select');
        var v = sel ? sel.value : '';
        if (sel) sel.value = '';
        if (v) { rte.insertHTML(esc(v)); caretAfterInsert(editor); }
      },
    });
  }

  /**
   * Paste into a text block arrives as PLAIN TEXT (line breaks kept). A rich
   * paste (Word, a web page) would bring tables, data: images and styles that
   * the server's component rules refuse — the editor never produces those.
   */
  function hardenCanvasDoc(editor, doc, seen) {
    if (!doc || seen.indexOf(doc) !== -1) return;
    seen.push(doc);
    doc.addEventListener('paste', function (e) {
      if (!editor.getEditing()) return;
      e.preventDefault();
      e.stopPropagation();
      var cd = e.clipboardData;
      var text = cd ? cd.getData('text/plain') : '';
      if (!text) return;
      doc.execCommand('insertHTML', false, esc(text).replace(/\r\n|\r|\n/g, '<br>'));
    }, true);
    // A file dropped on the canvas would become a base64 image.
    doc.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  /**
   * Boot an editor in `container`. opts: { win, placeholders, pickImage,
   * notify(msg, icon), projectData? } → Promise<editor>. New designs start
   * from the starter template; a stored design loads through loadDesign().
   */
  async function createEditor(container, opts) {
    opts = opts || {};
    var win = opts.win || root;
    var libs = await loadLibs(win);
    var ctx = { placeholders: opts.placeholders || [], pickImage: opts.pickImage, notify: opts.notify, origin: originOf(win) };
    var pluginOpts = {
      blocks: BLOCKS.slice(),
      imagePlaceholderSrc: ctx.origin + '/assets/icon-512.png',
      importPlaceholder: '',
    };
    var editor = libs.grapesjs.init({
      container: container,
      height: '100%',
      width: 'auto',
      fromElement: false,
      storageManager: false,
      plugins: [function (ed) { return libs.plugin(ed, pluginOpts); }],
      canvas: { frameContent: CANVAS_FRAME_CONTENT, allowExternalDrop: false },
      assetManager: { upload: false, embedAsBase64: false, assets: [] },
    });
    await new Promise(function (resolve) { editor.onReady(resolve); });

    installTypes(editor, ctx);
    installCommands(editor, ctx);
    installRte(editor, ctx);
    editor.Blocks.add('yc-header', {
      label: 'Header',
      category: (editor.Blocks.get('mj-text') && editor.Blocks.get('mj-text').get('category')) || 'Basic',
      media: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 4h18v6H3zM6 13h12v2H6zm0 4h8v2H6z"/></svg>',
      content: headerMjml(ctx.origin),
      select: true,
    });

    var seen = [];
    editor.on('canvas:frame:load', function (ev) {
      try { hardenCanvasDoc(editor, ev && ev.window && ev.window.document, seen); } catch (_) { /* best effort; Canvas.getDocument below */ }
    });
    hardenCanvasDoc(editor, editor.Canvas.getDocument(), seen);

    var pinning = false;
    editor.on('component:add', function (c) {
      if (pinning || editor.__ycLoading) return;   // a load ends in normalizeFooter()
      var p = c && c.parent && c.parent();
      if (!p || p.get('type') !== 'mj-body') return;
      pinning = true;
      try { repinFooter(editor); } finally { pinning = false; }
    });

    if (opts.projectData) loadDesign(editor, opts.projectData);
    else newDesign(editor);
    return editor;
  }

  /** Clears the history so undo cannot walk back past the load (Q5 item 2). */
  function settle(editor) {
    editor.UndoManager.clear();
    if (typeof editor.clearDirtyCount === 'function') editor.clearDirtyCount();
  }

  function newDesign(editor) {
    editor.__ycLoading = true;
    try { editor.setComponents(starterMjml(originOf(root))); } finally { editor.__ycLoading = false; }
    var r = normalizeFooter(editor);
    settle(editor);
    return r;
  }

  /** design_json (object or JSON string) → the editor, footer normalized, history cleared. */
  function loadDesign(editor, designJson) {
    var data = typeof designJson === 'string' ? JSON.parse(designJson) : designJson;
    if (!data || typeof data !== 'object') throw new Error('This design has no content');
    editor.__ycLoading = true;
    try { editor.loadProjectData(data); } finally { editor.__ycLoading = false; }
    var r = normalizeFooter(editor);
    settle(editor);
    return r;
  }

  // ── Export ────────────────────────────────────────────────────────────
  /**
   * End rich-text editing EXPLICITLY (findings Q1 risk): the last keystrokes
   * reach the model only when the RTE is disabled, and a programmatic select
   * did not sync them. → true when an edit session was ended.
   */
  async function endRte(editor) {
    var comp = editor.getEditing();
    if (!comp) return false;
    var view = (typeof comp.getView === 'function' && comp.getView()) || comp.view;
    if (view && typeof view.disableEditing === 'function') await view.disableEditing();
    return true;
  }

  /** → { design_json, html, text, mjml, warnings } — what a save or a send uses. */
  async function exportDesign(editor) {
    await endRte(editor);
    var design_json = editor.getProjectData();
    var mjml = editor.getHtml();
    var r = editor.runCommand('mjml-code-to-html') || {};
    var html = String(r.html || '');
    var warnings = (r.errors || []).map(function (e) { return (e && (e.formattedMessage || e.message)) || String(e); });
    return { design_json: design_json, html: html, text: deriveText(html), mjml: mjml, warnings: warnings };
  }

  // ── Pure helpers (unit-tested in Node) ────────────────────────────────
  var BLOCK_TAGS = { p: 1, div: 1, table: 1, tr: 1, li: 1, ul: 1, ol: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, blockquote: 1, section: 1, center: 1 };

  /**
   * A plain-text version of compiled html, for the design library row:
   * head / style / script / title and comments dropped, hidden elements
   * (MJML's preheader) skipped, links kept visible as `label (url)` (the bare
   * url when the label is the url), line breaks at block elements and <br>,
   * whitespace collapsed. The SEND path does not use it — C2 builds a
   * campaign's text part from the body itself (campaignService.textPartFor).
   */
  function deriveText(html, Parser) {
    var P = Parser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!P) throw new Error('deriveText needs a DOMParser');
    var doc = new P().parseFromString(String(html == null ? '' : html), 'text/html');
    var out = [];
    function visible(el) { return !/display\s*:\s*none/i.test(el.getAttribute('style') || ''); }
    function linkLabel(a) {
      var t = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t;
      var img = a.querySelector('img[alt]');
      return img ? img.getAttribute('alt').trim() : '';
    }
    function walk(n, depth) {
      if (depth > 200) return;
      if (n.nodeType === 3) { out.push(n.nodeValue.replace(/\s+/g, ' ')); return; }
      if (n.nodeType !== 1) return;
      var tag = n.tagName.toLowerCase();
      if (tag === 'head' || tag === 'style' || tag === 'script' || tag === 'title' || tag === 'noscript') return;
      if (!visible(n)) return;
      if (tag === 'br') { out.push('\n'); return; }
      if (tag === 'img') return;
      if (tag === 'a') {
        var href = (n.getAttribute('href') || '').trim();
        var label = linkLabel(n);
        var keep = /^(https?:|mailto:|tel:)/i.test(href) || href.indexOf('{{') === 0;
        out.push(keep ? (label && label !== href ? label + ' (' + href + ')' : href) : label);
        return;
      }
      var block = !!BLOCK_TAGS[tag];
      if (block) out.push('\n');
      for (var c = n.firstChild; c; c = c.nextSibling) walk(c, depth + 1);
      if (block) out.push('\n');
    }
    if (doc.body) walk(doc.body, 0);
    var lines = out.join('').split('\n').map(function (l) { return l.replace(/[ \t ]+/g, ' ').trim(); });
    var res = [];
    for (var i = 0; i < lines.length; i++) {
      if (lines[i] === '' && (res.length === 0 || res[res.length - 1] === '')) continue;
      res.push(lines[i]);
    }
    while (res.length && res[res.length - 1] === '') res.pop();
    return res.join('\n');
  }

  function walkComponents(node, fn, depth) {
    if (!node || typeof node !== 'object' || depth > 200) return;
    fn(node, depth);
    var kids = node.components;
    if (Array.isArray(kids)) for (var i = 0; i < kids.length; i++) walkComponents(kids[i], fn, depth + 1);
  }

  function findBodyJson(design) {
    var found = null;
    var pages = (design && design.pages) || [];
    pages.forEach(function (pg) {
      (pg.frames || []).forEach(function (fr) {
        walkComponents(fr.component, function (n) { if (!found && n.type === 'mj-body') found = n; }, 0);
      });
    });
    return found;
  }

  // Server rule 6 (findings; C3a): URL-valued attributes.
  var URL_ATTRS = { href: 1, src: 1, srcset: 1, background: 1, 'background-url': 1, poster: 1, data: 1, cite: 1 };
  var URL_TAG_STARTS = ['{{send.unsubscribe_url}}', '{{send.preferences_url}}'];
  /** → null when the server would accept the address, else a reason. Empty passes. */
  function urlProblem(value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return null;
    if (v.indexOf('{{') === 0) {
      for (var i = 0; i < URL_TAG_STARTS.length; i++) if (v.indexOf(URL_TAG_STARTS[i]) === 0) return null;
      return 'starts with a merge tag';
    }
    if (/^(https?:\/\/|mailto:|tel:|#)/i.test(v)) return null;
    return 'is not a full https://, mailto: or tel: address';
  }

  function isFooterJson(n) {
    return !!n && n.type === 'mj-section' && String((n.attributes || {})['css-class'] || '').split(/\s+/).indexOf(FOOTER_CLASS) !== -1;
  }

  /**
   * The editor's own check before it sends anything to the server — normal
   * use never fails it; it exists so a broken state is caught here with a
   * plain message instead of as a server rule number. NOT a security check
   * (the server's rules are). → array of problem strings (empty = fine).
   */
  function checkExport(out) {
    var problems = [];
    var html = String((out && out.html) || '');
    var n = countOf(html, FOOTER_SLOT);
    if (n !== 1) problems.push('The email must contain the footer slot exactly once (found ' + n + ').');
    if (/\bsrc\s*=\s*["']?\s*data:/i.test(html)) problems.push('An image is embedded in the email; images must come from the asset library.');
    var urlIssues = [];
    var imgInText = false;
    var pages = (out && out.design_json && out.design_json.pages) || [];
    pages.forEach(function (pg) {
      (pg.frames || []).forEach(function (fr) {
        walkComponents(fr.component, function (n) {
          var a = n.attributes || {};
          for (var k in a) {
            if (!Object.prototype.hasOwnProperty.call(a, k) || !URL_ATTRS[k]) continue;
            var why = urlProblem(a[k]);
            if (why && urlIssues.length < 3) urlIssues.push('"' + String(a[k]).slice(0, 60) + '" ' + why);
          }
          if (n.type === 'mj-text') {
            walkComponents(n, function (c, depth) {
              if (depth > 0 && (c.type === 'image' || String(c.tagName || '').toLowerCase() === 'img')) imgInText = true;
            }, 0);
          }
        }, 0);
      });
    });
    if (urlIssues.length) problems.push('A link or image address must be a full https:// (or mailto: / tel:) address, with any merge tag after the start: ' + urlIssues.join('; ') + '.');
    if (imgInText) problems.push('An image sits inside a text block; use an Image block instead.');
    var body = findBodyJson(out && out.design_json);
    if (!body) problems.push('The design has no email body.');
    else {
      var kids = body.components || [];
      var footers = kids.filter(isFooterJson);
      var last = kids[kids.length - 1];
      if (footers.length !== 1 || !isFooterJson(last)) problems.push('The locked footer must be the last block of the email.');
      else {
        var visibleText = [];
        var markers = 0;
        walkComponents(last, function (c) {
          if (c.type === 'comment' && String(c.content || '').trim() === FOOTER_SLOT_CONTENT.trim()) markers++;
          else if (c.type === 'textnode' && String(c.content || '').trim()) visibleText.push(c.content);
          else if (c.content && c.type !== 'comment' && String(c.content).trim()) visibleText.push(c.content);
        }, 0);
        if (markers !== 1 || visibleText.length) problems.push('The locked footer must hold only the footer slot.');
      }
    }
    return problems;
  }

  // Server rule names (findings "Server-side validation rules", 1–10) — a
  // 400 design_rejected names the rule by number; the editor shows both.
  var RULE_NAMES = Object.freeze({
    1: 'design structure', 2: 'block type', 3: 'script', 4: 'attribute', 5: 'raw content',
    6: 'link or image address', 7: 'HTML', 8: 'styles', 9: 'footer slot', 10: 'size',
  });

  /** An apiSend error → { title, text } for the user; a design_rejected names its rule and detail. */
  function rejectionMessage(err) {
    var b = (err && err.body) || {};
    if (err && err.status === 400 && b.code === 'design_rejected') {
      var name = RULE_NAMES[b.rule];
      return {
        title: 'The server refused this design',
        text: 'Rule ' + (b.rule == null ? '?' : b.rule) + (name ? ' (' + name + ')' : '') + ': ' + String(b.detail || b.error || 'no detail given'),
      };
    }
    return { title: 'Save failed', text: (err && err.message) || 'Unknown error' };
  }

  // ── The /api/email-designs contract (C3a) ─────────────────────────────
  var API = '/api/email-designs';
  function designPayload(name, out) {
    return { name: String(name), design_json: out.design_json, html: out.html, text: out.text };
  }
  function saveDesign(apiSend, id, payload) {
    return id != null
      ? apiSend(API + '/' + encodeURIComponent(id), 'PUT', payload)
      : apiSend(API, 'POST', payload);
  }
  function listDesigns(apiSend, q, includeArchived) {
    var qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (includeArchived) qs.set('include_archived', '1');
    var s = qs.toString();
    return apiSend(API + (s ? '?' + s : ''), 'GET');
  }
  function getDesign(apiSend, id) { return apiSend(API + '/' + encodeURIComponent(id), 'GET'); }
  function setArchived(apiSend, id, archived) { return apiSend(API + '/' + encodeURIComponent(id), 'PATCH', { archived: !!archived }); }

  /** Insert a merge tag at the caret of the text being edited. → false when no text is being edited. */
  function insertMergeTag(editor, tag) {
    if (!editor || !editor.getEditing() || !tag) return false;
    var rte = editor.RichTextEditor && editor.RichTextEditor.globalRte;
    if (rte && typeof rte.insertHTML === 'function') { rte.insertHTML(esc(tag)); caretAfterInsert(editor); return true; }
    var doc = editor.Canvas.getDocument();
    return !!doc.execCommand('insertHTML', false, esc(tag));
  }

  return {
    LIBS: LIBS,
    FOOTER_SLOT: FOOTER_SLOT,
    FOOTER_CLASS: FOOTER_CLASS,
    CANVAS_FRAME_CONTENT: CANVAS_FRAME_CONTENT,
    BLOCKS: BLOCKS,
    FOOTER_FLAGS: FOOTER_FLAGS,
    REFUSED_COMMANDS: REFUSED_COMMANDS,
    REMOVED_RTE_ACTIONS: REMOVED_RTE_ACTIONS,
    PREVIEW_ATTR: PREVIEW_ATTR,
    PREVIEW_LINES: PREVIEW_LINES,
    RULE_NAMES: RULE_NAMES,
    API: API,
    loadLibs: loadLibs,
    starterMjml: starterMjml,
    headerMjml: headerMjml,
    placeholdersFrom: placeholdersFrom,
    tagSelectHtml: tagSelectHtml,
    createEditor: createEditor,
    newDesign: newDesign,
    loadDesign: loadDesign,
    normalizeFooter: normalizeFooter,
    repinFooter: repinFooter,
    findFooter: findFooter,
    endRte: endRte,
    exportDesign: exportDesign,
    deriveText: deriveText,
    checkExport: checkExport,
    urlProblem: urlProblem,
    rejectionMessage: rejectionMessage,
    designPayload: designPayload,
    saveDesign: saveDesign,
    listDesigns: listDesigns,
    getDesign: getDesign,
    setArchived: setArchived,
    insertMergeTag: insertMergeTag,
  };
});
