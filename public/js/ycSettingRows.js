/* public/js/ycSettingRows.js — app_settings ROWS for the Config sub-pages
 * (settings / config-split arc, 2026-10).
 *
 * ONE renderer for the rows GET /api/app-settings serves (the ROW shape:
 * lib/settingsRegistry.js is the spine, routes/api.appSettings.js serves it).
 * Used by the Config shell's sub-pages — the Firm, System and Lists tabs
 * (caseconfig/firm.html, system.html, lists.html). Framework-free; a page
 * loads it with a plain <script src="/js/ycSettingRows.js"> in its <head>.
 *
 * USE
 *   const view = ycSettingRows.create({
 *     container,  Element — the rows are drawn into it (its children replaced)
 *     rows,       ROW[] in display order (the server's order)
 *     api,        (path, method?, body?) → Promise — the shell's apiSend relay
 *                 (P.apiSend); a failure is an ApiError (.status, .message)
 *     users,      () → firmData.users (or the array) — the staff list the
 *                 user / user_csv controls draw from
 *     lookups,    optional — ycSettingRows.lookups(api), shared by every view
 *                 of one page load: the credential / sequence lists, ONE GET
 *                 each, made only when a row of that type is drawn
 *     editors,    optional { <ROW.editor>: (row, ctx) → editor | null } (below)
 *     confirm,    optional async (title, text) → boolean; default window.confirm
 *     empty,      optional text shown when there are no rows
 *     onDirty,    optional () → void — after anything that may change isDirty()
 *   });
 *   view.isDirty()      → boolean
 *   view.dirtyKeys()    → [key], in display order
 *   view.value(key)     → the string a save would send (the stored one, byte
 *                         for byte, while the control is untouched)
 *   view.save()         → Promise<{ ok, saved:[key], failed:[key],
 *                         errors:{ key: { status, message } } }> — PUTs each
 *                         dirty key, one at a time, in display order; a saved
 *                         row is redrawn from the response; a failed one stays
 *                         dirty with the reason on its status line
 *   view.setRows(rows)  → redraw from new rows (unsaved edits are dropped)
 *   view.addRow(row)    → append one row (a variable the page just created)
 *   view.rows()         → the ROW objects, as last stored
 *   view.ready          → Promise, resolved once every lookup list is drawn
 *
 * THE CONTROLS — one per ROW.type (lib/settingsRegistry TYPES):
 *   string, number, duration, email, phone, url, csv, date, and any type a
 *              migration wrote (or this file does not know yet): a single-line
 *              text input (monospace for url / csv / date / phone / number /
 *              duration) with the whitespace badge; a stored value holding a
 *              line break gets a textarea instead (an input silently drops
 *              line breaks)
 *   template, json   a textarea
 *   bool       a checkbox → '1' / '0'
 *   enum       a select: blank + ROW.options
 *   user       a select of ACTIVE staff (firmData.users: user_type and
 *              active !== false — the assign-picker rule, AI_CONTEXT §12)
 *   user_csv   chips of staff + "Add a person…" (active staff)
 *   json_array an editable list of strings (add / remove / reorder) when the
 *              stored value is an array of single-line strings; else a textarea
 *   credential / sequence   a select from GET /api/credentials /
 *              GET /sequences/templates (both jwtOrApiKey: any staff); while
 *              the list loads the select is disabled; if it cannot be loaded,
 *              an id input with a hint
 *   ROW.required (true = the server refuses a blank value): a "required"
 *   marker in the label, and no blank choice in a select (user / enum /
 *   credential / sequence) — a blank stored value shows a disabled "Choose…"
 *   until something is picked.
 *   KEEP-CURRENT (access D3b, ref/plans.md "Delegation addendum"): a stored
 *   value a picker would not offer — an inactive or unknown user, an inactive
 *   sequence, a missing credential, an enum value not among the options —
 *   stays selected, as its own labelled option, so an untouched save never
 *   changes it.
 *
 * VERBATIM: a value is set with .value / textContent, never innerHTML, and
 * never trimmed — leading / trailing spaces are load-bearing for some keys
 * (Dropbox folder names). An UNTOUCHED control reports the stored string
 * exactly (controls that rebuild a value — bool, user_csv, json_array, a
 * custom editor — hand back the stored string while what they show equals
 * it), so a row is dirty only after a real edit.
 *
 * EACH ROW: label (.yc-flabel), the key in small monospace, the description
 * (.yc-hint), "Blank falls back to the <env> environment variable" when ROW.env
 * is set, "Not set — the code's default applies" when ROW.exists is false,
 * the last update, a status line (a 400 / 403 / 404 / 409 message shown
 * verbatim), and — can_edit only — History: GET /api/app-settings/:key/history
 * listed inline ("changed A → B by <name>, <when>, <via>") with "Restore this
 * value" per entry → POST /api/app-settings/:key/restore { version_id } (after
 * a confirm), which puts back that entry's OLD value; the row is redrawn from
 * the response. After a save batch or a restore that wrote an fe-* key, the
 * shell's window.top.loadFirmData() runs once: the shell's own surfaces (the Cases-tab type filter, the Events
 * filter, firm logo / phone) re-read firmData. can_edit false: the value as
 * text, no controls; edit
 * 'console' says it is changed from the SU db console. A row whose ROW.editor
 * names no editor the page passed is shown read-only (a key with a dedicated
 * editor is never edited blind from a plain row).
 *
 * EDITORS: editors[ROW.editor](row, ctx) builds a dedicated control for that
 * key (the Firm tab's Dropbox folder templates). ctx = { doc, id, changed() }:
 * give the first focusable element ctx.id, call ctx.changed() after every
 * edit. Return { el, get() → string, problem?() → string|null, focusId? }, or
 * null to fall back to the type's own control (e.g. a stored value the editor
 * cannot read). get() must hand back row.value exactly while nothing changed;
 * problem() → a message blocks that row's save (shown on its status line).
 *
 * The page provides the look of .yc-flabel / .yc-hint (AI_CONTEXT §12) and
 * .btn / .btn-outline / .btn-sm (every Config sub-page has them). This file
 * injects the rest once per document (<style id="ycSettingRowsCss">, theme.css
 * tokens), every rule scoped under .ycsr so it outranks a page's own input /
 * select rules on specificity, never on load order. No fixed widths: rows are
 * one column on phones, label | control from 720px.
 *
 * Tests: tests/ycSettingRows.test.js (jsdom, a fake apiSend speaking the
 * settings API contract), tests/firmTab.test.js (the Firm tab),
 * tests/configSystemTab.test.js, tests/configListsTab.test.js.
 */
(function (root) {
  'use strict';

  var CSS = [
    '.ycsr { display: block; min-width: 0; }',
    '.ycsr .ycsr-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px 16px; padding: 10px 0; border-bottom: 1px solid var(--border); min-width: 0; }',
    '.ycsr .ycsr-row:last-child { border-bottom: none; }',
    '.ycsr .ycsr-row.is-dirty { box-shadow: inset 3px 0 0 var(--warn); padding-left: 10px; }',
    '.ycsr .ycsr-info, .ycsr .ycsr-main { min-width: 0; }',
    '.ycsr .ycsr-req { font-size: var(--fs-xs); font-weight: 600; color: var(--danger); }',
    '.ycsr .ycsr-key { display: block; font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 11px; color: var(--text-muted); overflow-wrap: anywhere; }',
    '.ycsr .ycsr-main input[type=text], .ycsr .ycsr-main select, .ycsr .ycsr-main textarea {',
    '  width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border);',
    '  border-radius: 6px; font-size: 13px; font-family: inherit; background: var(--page-bg); color: var(--text); outline: none; }',
    '.ycsr .ycsr-main textarea { resize: vertical; min-height: 4.5em; line-height: 1.4; }',
    '.ycsr .ycsr-main input[type=text].ycsr-mono, .ycsr .ycsr-main textarea.ycsr-mono { font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 12px; }',
    '.ycsr .ycsr-main input[type=text]:focus, .ycsr .ycsr-main select:focus, .ycsr .ycsr-main textarea:focus { border-color: var(--info); }',
    '.ycsr .ycsr-main select:disabled { opacity: .6; }',
    '.ycsr .ycsr-ws { font-size: var(--fs-xs); color: var(--warn); margin-top: 2px; overflow-wrap: anywhere; }',
    '.ycsr .ycsr-ws[hidden] { display: none; }',
    '.ycsr .ycsr-toggle { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-size: 13px; }',
    '.ycsr .ycsr-toggle input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); cursor: pointer; }',
    '.ycsr .ycsr-people { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; }',
    '.ycsr .ycsr-main .ycsr-people select { width: auto; max-width: 100%; flex: 0 1 14em; padding: 3px 6px; font-size: 12px; }',
    '.ycsr .ycsr-chip { display: inline-flex; align-items: center; gap: 2px; padding: 1px 2px 1px 8px; border-radius: 12px;',
    '  background: var(--surface-2); border: 1px solid var(--border); max-width: 100%; overflow-wrap: anywhere; }',
    '.ycsr .ycsr-chip button { border: none; background: none; color: var(--text-2); cursor: pointer; padding: 0 5px; font-size: 14px; line-height: 1; font-family: inherit; }',
    '.ycsr .ycsr-chip button:hover { color: var(--danger); }',
    '.ycsr .ycsr-none { color: var(--text-muted); font-size: 12px; }',
    '.ycsr .ycsr-li { display: flex; align-items: flex-start; gap: 4px; margin-bottom: 4px; min-width: 0; }',
    '.ycsr .ycsr-li-in { flex: 1 1 auto; min-width: 0; }',
    '.ycsr .ycsr-li .btn { flex: 0 0 auto; }',
    '.ycsr .ycsr-ro { font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; padding: 6px 8px; background: var(--surface-2); border-radius: 6px; }',
    '.ycsr .ycsr-ro-blank { color: var(--text-muted); font-style: italic; }',
    '.ycsr .ycsr-hints .yc-hint { margin-top: 3px; }',
    '.ycsr .ycsr-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 4px; }',
    '.ycsr .ycsr-foot .yc-hint { margin: 0; }',
    '.ycsr .ycsr-status { font-size: 12px; flex: 1 1 10em; min-width: 0; overflow-wrap: anywhere; }',
    '.ycsr .ycsr-status.err { color: var(--danger); }',
    '.ycsr .ycsr-status.ok { color: var(--ok); }',
    '.ycsr .ycsr-hist { grid-column: 1 / -1; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--page-bg); min-width: 0; }',
    '.ycsr .ycsr-hist[hidden] { display: none; }',
    '.ycsr .ycsr-hist-title { font-size: 13px; font-weight: 700; }',
    '.ycsr .ycsr-hist-msg { font-size: 12px; color: var(--text-muted); padding: 4px 0; overflow-wrap: anywhere; }',
    '.ycsr .ycsr-ver { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 6px 0; border-bottom: 1px solid var(--border); }',
    '.ycsr .ycsr-ver:last-child { border-bottom: none; }',
    '.ycsr .ycsr-ver-line { flex: 1 1 16em; min-width: 0; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }',
    '.ycsr .ycsr-val { font-family: var(--mono, ui-monospace, Menlo, monospace); background: var(--surface-2); border-radius: 4px; padding: 0 3px; }',
    '.ycsr .ycsr-val-none { font-family: inherit; color: var(--text-muted); background: none; padding: 0; }',
    '.ycsr .ycsr-empty { font-size: 13px; color: var(--text-muted); padding: 6px 2px; }',
    '@media (min-width: 720px) { .ycsr .ycsr-row { grid-template-columns: minmax(11em, 2fr) minmax(0, 3fr); } }',
  ].join('\n');

  function ensureCss(doc) {
    if (doc.getElementById('ycSettingRowsCss')) return;
    var st = doc.createElement('style');
    st.id = 'ycSettingRowsCss';
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  function noop() {}
  var seq = 0;

  function mk(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(doc, cls, text) {
    var b = mk(doc, 'button', cls, text);
    b.type = 'button';
    return b;
  }
  function option(doc, value, label) {
    var o = doc.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  }

  /** The stored value as a string ('' when the row does not exist yet). */
  function stored(row) { return row.value == null ? '' : String(row.value); }
  function same(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  var LINE_BREAK = /[\r\n]/;

  /** The whitespace badge (settings.html wsHint): leading / trailing spaces
   *  are preserved on save, and said so. Counted with loops, not regexes. */
  function isWs(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' '; }
  function wsHint(v) {
    var s = v == null ? '' : String(v);
    if (!s) return '';
    var lead = 0;
    while (lead < s.length && isWs(s.charAt(lead))) lead++;
    if (lead === s.length) return '⚠ only spaces (' + s.length + ') — preserved on save';
    var trail = 0;
    while (isWs(s.charAt(s.length - 1 - trail))) trail++;
    if (!lead && !trail) return '';
    var parts = [];
    if (lead) parts.push(lead + ' leading space' + (lead > 1 ? 's' : ''));
    if (trail) parts.push(trail + ' trailing space' + (trail > 1 ? 's' : ''));
    return '⚠ ' + parts.join(', ') + ' — preserved on save';
  }

  function fmtWhen(ts) {
    if (ts == null || ts === '') return '';
    var d = new Date(ts);
    return isNaN(d) ? String(ts) : d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function short(s) { return s.length > 300 ? s.slice(0, 300) + '…' : s; }

  /** A request error → the line to show. The server's own sentence for the
   *  refusals it explains (400 / 403 / 404 / 409); anything else prefixed. */
  function errMsg(e, prefix) {
    var st = e && e.status;
    var m = (e && e.message) || 'request failed';
    return (st === 400 || st === 403 || st === 404 || st === 409) ? m : prefix + ': ' + m;
  }

  // ── staff (firmData.users) ─────────────────────────────────────────────────
  function staffOf(users) {
    return users.filter(function (u) { return u && u.user_type && u.active !== false; });
  }
  /** A stored user id → its label; a user a picker would not offer says why. */
  function userLabel(users, id) {
    var t = String(id).trim();
    var u = users.filter(function (x) { return x && String(x.user) === t; })[0];
    if (!u) return 'user #' + t + ' (not in the staff list)';
    var name = u.user_name || ('user #' + u.user);
    if (u.active === false) return name + ' (inactive)';
    if (!u.user_type) return name + ' (not a staff member)';
    return name;
  }

  // ── lookup lists (credential / sequence) ───────────────────────────────────
  var LOOKUPS = {
    credential: {
      path: '/api/credentials',
      list: function (r) { return r && r.credentials; },
      item: function (c) {
        return { value: String(c.id), inactive: false,
          label: String(c.name == null ? 'credential' : c.name) + ' (#' + c.id + (c.type ? ', ' + c.type : '') + ')' };
      },
    },
    sequence: {
      path: '/sequences/templates',
      list: function (r) { return r && r.templates; },
      item: function (t) {
        return { value: String(t.id), inactive: !(t.active === true || Number(t.active) === 1),
          label: String(t.name == null ? 'sequence' : t.name) + ' (#' + t.id + (t.type ? ', ' + t.type : '') + ')' };
      },
    },
  };
  /** One memoised GET per list; resolves to [{ value, label, inactive }] or
   *  null when the list cannot be read. */
  function lookups(api) {
    var memo = {};
    return {
      get: function (type) {
        var src = LOOKUPS[type];
        if (!src) return Promise.resolve(null);
        if (!memo[type]) {
          memo[type] = Promise.resolve()
            .then(function () { return api(src.path); })
            .then(function (r) {
              var l = src.list(r);
              return Array.isArray(l) ? l.filter(function (x) { return x && x.id != null; }).map(src.item) : null;
            }, function () { return null; });
        }
        return memo[type];
      },
    };
  }

  // ── controls ───────────────────────────────────────────────────────────────
  // Each: (ctx, s, …) → { el, get() → string, focusId?, problem?() }.
  // ctx = { doc, id, changed(), required, users, lk, pending }.
  var MONO = { url: 1, csv: 1, date: 1, phone: 1, number: 1, duration: 1, credential: 1, sequence: 1 };

  function textControl(ctx, s, type) {
    var doc = ctx.doc;
    var inp = mk(doc, 'input', MONO[type] ? 'ycsr-mono' : '');
    inp.type = 'text';
    inp.id = ctx.id;
    inp.autocomplete = 'off';
    inp.spellcheck = !MONO[type];
    if (type === 'number') inp.setAttribute('inputmode', 'decimal');
    if (type === 'credential' || type === 'sequence') inp.setAttribute('inputmode', 'numeric');
    inp.value = s;
    var cur = s;
    var badge = mk(doc, 'div', 'ycsr-ws');
    function paint() { var h = wsHint(inp.value); badge.textContent = h; badge.hidden = !h; }
    paint();
    inp.addEventListener('input', function () { cur = inp.value; paint(); ctx.changed(); });
    var box = mk(doc, 'div', 'ycsr-text');
    box.appendChild(inp);
    box.appendChild(badge);
    return { el: box, focusId: ctx.id, get: function () { return cur; } };
  }

  function areaControl(ctx, s, type) {
    var ta = mk(ctx.doc, 'textarea', type === 'json' || type === 'json_array' ? 'ycsr-mono' : '');
    ta.id = ctx.id;
    ta.spellcheck = type === 'template' || type === 'string';
    ta.rows = type === 'template' ? 4 : type === 'json' || type === 'json_array' ? 6 : 3;
    ta.value = s;
    var cur = s;
    ta.addEventListener('input', function () { cur = ta.value; ctx.changed(); });
    return { el: ta, focusId: ctx.id, get: function () { return cur; } };
  }
  /** A free-text type: an input, or a textarea when the value has a line break. */
  function freeControl(ctx, s, type) {
    return LINE_BREAK.test(s) ? areaControl(ctx, s, type) : textControl(ctx, s, type);
  }

  function boolText(v) {
    var t = v.trim();
    if (t === '1') return 'On (1)';
    if (t === '0') return 'Off (0)';
    if (v === '') return 'Not set';
    return 'Off — stored as “' + v + '”';
  }
  function boolControl(ctx, s) {
    var doc = ctx.doc;
    var on0 = s.trim() === '1';
    var cb = mk(doc, 'input');
    cb.type = 'checkbox';
    cb.id = ctx.id;
    cb.checked = on0;
    var txt = mk(doc, 'span', 'ycsr-toggle-txt');
    var lab = mk(doc, 'label', 'ycsr-toggle');
    lab.appendChild(cb);
    lab.appendChild(txt);
    var cur = s;
    function paint() { txt.textContent = boolText(cur); }
    paint();
    cb.addEventListener('change', function () {
      // back where it started → the stored string, whatever it was ('', ' 1')
      cur = cb.checked === on0 ? s : (cb.checked ? '1' : '0');
      paint();
      ctx.changed();
    });
    return { el: lab, focusId: ctx.id, get: function () { return cur; } };
  }

  /** A select: blank (none when the row is required — a blank stored value
   *  shows a disabled "Choose…"), then the kept stored value (if not
   *  offered), then opts. */
  function selectControl(ctx, s, opts, blankLabel, keptLabel) {
    var doc = ctx.doc;
    var sel = mk(doc, 'select');
    sel.id = ctx.id;
    if (!ctx.required) sel.appendChild(option(doc, '', blankLabel));
    else if (s === '') {
      var ph = option(doc, '', 'Choose…');
      ph.disabled = true;
      sel.appendChild(ph);
    }
    if (s !== '' && !opts.some(function (o) { return o.value === s; })) {
      var k = option(doc, s, keptLabel(s));
      k.setAttribute('data-ycsr-kept', '');
      sel.appendChild(k);
    }
    opts.forEach(function (o) { sel.appendChild(option(doc, o.value, o.label)); });
    sel.value = s;
    var cur = s;
    sel.addEventListener('change', function () { cur = sel.value; ctx.changed(); });
    return { el: sel, focusId: ctx.id, get: function () { return cur; } };
  }

  function enumControl(ctx, s, row) {
    var opts = (Array.isArray(row.options) ? row.options : []).map(function (v) { return { value: String(v), label: String(v) }; });
    return selectControl(ctx, s, opts, '— not set —', function (v) { return '“' + v + '” (as stored)'; });
  }

  function userControl(ctx, s) {
    var users = ctx.users;
    var opts = staffOf(users).map(function (u) { return { value: String(u.user), label: u.user_name || ('user #' + u.user) }; });
    return selectControl(ctx, s, opts, '— none —', function (v) {
      return userLabel(users, v) + (v.trim() !== v ? ' — stored as “' + v + '”' : '');
    });
  }

  function userCsvControl(ctx, s) {
    var doc = ctx.doc, users = ctx.users;
    var toks = s.trim() === '' ? [] : s.split(',').map(function (t) { return t.trim(); });
    if (toks.some(function (t) { return !/^\d{1,10}$/.test(t); })) return null;   // not a list of ids: free text
    var orig = toks.slice(), list = toks.slice();
    var box = mk(doc, 'div', 'ycsr-people');
    function draw(focusAdd) {
      box.textContent = '';
      if (!list.length) box.appendChild(mk(doc, 'span', 'ycsr-none', 'nobody'));
      list.forEach(function (id, i) {
        var label = userLabel(users, id);
        var chip = mk(doc, 'span', 'ycsr-chip');
        chip.appendChild(doc.createTextNode(label));
        var x = button(doc, '', '×');
        x.setAttribute('data-ycsr-rm', String(i));
        x.title = 'Remove ' + label;
        x.setAttribute('aria-label', 'Remove ' + label);
        chip.appendChild(x);
        box.appendChild(chip);
      });
      var sel = mk(doc, 'select', 'ycsr-add');
      sel.id = ctx.id;
      sel.setAttribute('aria-label', 'Add a person');
      sel.appendChild(option(doc, '', 'Add a person…'));
      staffOf(users).filter(function (u) { return list.indexOf(String(u.user)) < 0; })
        .forEach(function (u) { sel.appendChild(option(doc, String(u.user), u.user_name || ('user #' + u.user))); });
      box.appendChild(sel);
      if (focusAdd) sel.focus();
    }
    box.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t.classList.contains('ycsr-add') || !t.value) return;
      list.push(t.value);
      draw(true);
      ctx.changed();
    });
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-ycsr-rm]');
      if (!b) return;
      list.splice(Number(b.getAttribute('data-ycsr-rm')), 1);
      draw(true);
      ctx.changed();
    });
    draw(false);
    return { el: box, focusId: ctx.id, get: function () { return same(list, orig) ? s : list.join(','); } };
  }

  function listControl(ctx, s) {
    var doc = ctx.doc;
    var blank = s.trim() === '';
    var orig = [];
    if (!blank) {
      try { orig = JSON.parse(s); } catch (e) { return null; }
      if (!Array.isArray(orig) || orig.some(function (x) { return typeof x !== 'string' || LINE_BREAK.test(x); })) return null;
    }
    var list = orig.slice();
    var box = mk(doc, 'div', 'ycsr-list');
    var rows = mk(doc, 'div', 'ycsr-li-rows');
    var add = button(doc, 'btn btn-outline btn-sm', '+ Add entry');
    add.setAttribute('data-ycsr-li', 'add');
    box.appendChild(rows);
    box.appendChild(add);
    function wsPaint(badge, v) { var h = wsHint(v); badge.textContent = h; badge.hidden = !h; }
    function draw(focusAt) {
      rows.textContent = '';
      if (!list.length) rows.appendChild(mk(doc, 'div', 'ycsr-none', 'No entries.'));
      list.forEach(function (v, i) {
        var r = mk(doc, 'div', 'ycsr-li');
        var cell = mk(doc, 'div', 'ycsr-li-in');
        var inp = mk(doc, 'input');
        inp.type = 'text';
        inp.value = v;
        inp.setAttribute('data-ycsr-entry', String(i));
        inp.setAttribute('aria-label', 'Entry ' + (i + 1));
        if (i === 0) inp.id = ctx.id;
        var badge = mk(doc, 'div', 'ycsr-ws');
        wsPaint(badge, v);
        cell.appendChild(inp);
        cell.appendChild(badge);
        r.appendChild(cell);
        [['up', '↑', 'Move up', i === 0], ['down', '↓', 'Move down', i === list.length - 1], ['del', '✕', 'Remove', false]].forEach(function (b) {
          var btn = button(doc, 'btn btn-outline btn-sm', b[1]);
          btn.setAttribute('data-ycsr-li', b[0]);
          btn.setAttribute('data-i', String(i));
          btn.title = b[2];
          btn.setAttribute('aria-label', b[2] + ' entry ' + (i + 1));
          btn.disabled = b[3];
          r.appendChild(btn);
        });
        rows.appendChild(r);
      });
      if (focusAt != null) {
        var f = rows.querySelector('[data-ycsr-entry="' + focusAt + '"]');
        if (f) f.focus();
      }
    }
    rows.addEventListener('input', function (ev) {
      var t = ev.target, i = t.getAttribute('data-ycsr-entry');
      if (i == null) return;
      list[Number(i)] = t.value;
      wsPaint(t.parentNode.querySelector('.ycsr-ws'), t.value);
      ctx.changed();
    });
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-ycsr-li]');
      if (!b || b.disabled) return;
      var act = b.getAttribute('data-ycsr-li'), i = Number(b.getAttribute('data-i'));
      var focus = null;
      if (act === 'add') { list.push(''); focus = list.length - 1; }
      else if (act === 'up' && i > 0) { var u = list[i - 1]; list[i - 1] = list[i]; list[i] = u; focus = i - 1; }
      else if (act === 'down' && i < list.length - 1) { var d = list[i + 1]; list[i + 1] = list[i]; list[i] = d; focus = i + 1; }
      else if (act === 'del') { list.splice(i, 1); }
      else return;
      draw(focus);
      ctx.changed();
    });
    draw(null);
    return {
      el: box, focusId: ctx.id,
      get: function () {
        if (same(list, orig)) return s;
        return list.length === 0 && blank ? s : JSON.stringify(list);
      },
      problem: function () {
        return list.some(function (v) { return v.trim() === ''; }) ? 'An entry is empty — fill it in or remove it.' : null;
      },
    };
  }

  function lookupControl(ctx, s, type) {
    var doc = ctx.doc;
    var box = mk(doc, 'div', 'ycsr-lookup');
    var cur = s, inner = null;
    var wait = mk(doc, 'select');
    wait.id = ctx.id;
    wait.disabled = true;
    wait.appendChild(option(doc, s, 'Loading…'));
    box.appendChild(wait);
    var sub = { doc: doc, id: ctx.id, users: ctx.users, required: ctx.required, changed: function () { cur = inner.get(); ctx.changed(); } };
    ctx.pending.push(ctx.lk.get(type).then(function (list) {
      box.textContent = '';
      if (!list) {
        inner = textControl(sub, s, type);
        box.appendChild(inner.el);
        box.appendChild(mk(doc, 'span', 'yc-hint', 'The ' + (type === 'credential' ? 'credentials' : 'sequence') +
          ' list could not be loaded — enter the ' + (type === 'credential' ? 'credential' : 'sequence template') + ' id.'));
        return;
      }
      var known = list.filter(function (o) { return o.value === s; })[0];
      inner = selectControl(sub, s, list.filter(function (o) { return !o.inactive; }), '— none —', function (v) {
        return known ? known.label + ' (inactive)' : '#' + v + ' (not found)';
      });
      box.appendChild(inner.el);
    }));
    return { el: box, focusId: ctx.id, get: function () { return cur; } };
  }

  function defaultControl(ctx, row, s) {
    var t = row.type;
    if (t === 'bool') return boolControl(ctx, s);
    if (t === 'enum') return enumControl(ctx, s, row);
    if (t === 'user') return userControl(ctx, s);
    if (t === 'user_csv') return userCsvControl(ctx, s) || freeControl(ctx, s, 'csv');
    if (t === 'json_array') return listControl(ctx, s) || areaControl(ctx, s, 'json_array');
    if (t === 'credential' || t === 'sequence') return lookupControl(ctx, s, t);
    if (t === 'template' || t === 'json') return areaControl(ctx, s, t);
    return freeControl(ctx, s, t);   // string, number, email, phone, url, csv, date, any DB type
  }

  /** Read-only: the value as a person reads it (null = blank). */
  function displayText(row, s, users) {
    if (s === '') return null;
    if (row.type === 'bool') return boolText(s);
    if (row.type === 'user') return userLabel(users, s);
    if (row.type === 'user_csv') {
      var toks = s.split(',').map(function (x) { return x.trim(); });
      return toks.every(function (x) { return /^\d{1,10}$/.test(x); }) ? toks.map(function (x) { return userLabel(users, x); }).join(', ') : s;
    }
    return s;
  }

  /** settings.html's saveSetting rule: an fe-* key is in firmData.settings —
   *  the shell re-reads firmData so its own surfaces follow. Best effort. */
  function isFe(key) { return /^fe-/.test(String(key)); }
  function refreshFirmData(win) {
    try {
      var t = win && win.top;
      if (t && typeof t.loadFirmData === 'function') {
        var p = t.loadFirmData();
        if (p && typeof p.catch === 'function') p.catch(noop);
      }
    } catch (e) { /* another origin, or the shell refused: the next load catches up */ }
  }

  var VIA = { ui: 'in the app', api_key: 'by an API key', restore: 'by a restore', create: 'when it was created' };

  // ── the view ───────────────────────────────────────────────────────────────
  function create(opts) {
    var container = opts.container;
    var doc = container.ownerDocument;
    ensureCss(doc);
    container.classList.add('ycsr');
    var api = opts.api;
    var lk = opts.lookups || lookups(api);
    var editors = opts.editors || {};
    var onDirty = typeof opts.onDirty === 'function' ? opts.onDirty : noop;
    var confirmFn = typeof opts.confirm === 'function' ? opts.confirm
      : function (title, text) { return Promise.resolve(doc.defaultView.confirm(title + '\n\n' + text)); };
    var pending = [];
    var items = [];
    var saving = null;

    function users() {
      var u = typeof opts.users === 'function' ? opts.users() : opts.users;
      return Array.isArray(u) ? u : [];
    }
    function editable(row) { return row.can_edit === true || row.can_edit === 1; }
    function dirty(it) { return !!it.ctl && it.ctl.get() !== stored(it.row); }
    function valueOf(it) { return it.ctl ? it.ctl.get() : stored(it.row); }

    function setStatus(it, msg, kind) {
      if (!it.dom) return;
      it.dom.status.textContent = msg || '';
      it.dom.status.className = 'ycsr-status' + (kind ? ' ' + kind : '');
    }
    function changed(it) {
      if (it.dom) {
        it.dom.el.classList.toggle('is-dirty', dirty(it));
        setStatus(it, '', '');
      }
      onDirty();
    }

    function build(it) {
      var row = it.row, s = stored(row);
      var id = 'ycsr-' + (++seq);
      var el = mk(doc, 'div', 'ycsr-row');
      el.setAttribute('data-key', row.key);
      var info = mk(doc, 'div', 'ycsr-info');
      var lab = mk(doc, 'label', 'yc-flabel', row.label || row.key);
      var required = row.required === true;
      if (required) {
        lab.appendChild(doc.createTextNode(' '));
        lab.appendChild(mk(doc, 'span', 'ycsr-req', 'required'));
      }
      info.appendChild(lab);
      info.appendChild(mk(doc, 'code', 'ycsr-key', row.key));
      if (row.description) info.appendChild(mk(doc, 'span', 'yc-hint ycsr-desc', row.description));
      var main = mk(doc, 'div', 'ycsr-main');

      var ctl = null, canEdit = editable(row), roNote = null;
      var ctx = { doc: doc, id: id, required: required, users: users(), lk: lk, pending: pending, changed: function () { changed(it); } };
      if (canEdit && row.editor) {
        var f = editors[row.editor];
        if (typeof f !== 'function') { canEdit = false; roNote = 'This setting has its own editor; it is not changed here.'; }
        else ctl = f(row, { doc: doc, id: id, changed: ctx.changed }) || null;
      }
      if (canEdit && !ctl) ctl = defaultControl(ctx, row, s);
      if (canEdit) {
        main.appendChild(ctl.el);
        if (ctl.focusId) lab.htmlFor = ctl.focusId;
      } else {
        var t = displayText(row, s, ctx.users);
        var ro = mk(doc, 'div', 'ycsr-ro' + (t == null ? ' ycsr-ro-blank' : ''), t == null ? '(blank)' : t);
        ro.id = id;
        main.appendChild(ro);
        var h = t == null ? '' : wsHint(s);
        if (h) main.appendChild(mk(doc, 'div', 'ycsr-ws', h));
      }

      var hints = mk(doc, 'div', 'ycsr-hints');
      if (!canEdit) {
        hints.appendChild(mk(doc, 'span', 'yc-hint ycsr-posture', row.edit === 'console'
          ? 'Changed from the SU db console only.' : (roNote || 'Read-only — you can see it here but not change it.')));
      }
      if (row.env) hints.appendChild(mk(doc, 'span', 'yc-hint ycsr-env', 'Blank falls back to the ' + row.env + ' environment variable.'));
      var unset = null;
      if (row.exists === false) {
        unset = mk(doc, 'span', 'yc-hint ycsr-unset', 'Not set — the code\'s default applies.');
        hints.appendChild(unset);
      }
      main.appendChild(hints);

      var foot = mk(doc, 'div', 'ycsr-foot');
      var upd = mk(doc, 'span', 'yc-hint ycsr-updated', row.updated_at ? 'Updated ' + fmtWhen(row.updated_at) : '');
      var status = mk(doc, 'span', 'ycsr-status');
      status.setAttribute('role', 'status');
      foot.appendChild(upd);
      foot.appendChild(status);
      var hist = mk(doc, 'div', 'ycsr-hist');
      hist.hidden = true;
      var histBtn = null;
      if (canEdit) {
        histBtn = button(doc, 'btn btn-outline btn-sm', 'History');
        histBtn.setAttribute('data-ycsr', 'history');
        histBtn.setAttribute('aria-expanded', 'false');
        histBtn.addEventListener('click', function () { toggleHistory(it); });
        foot.appendChild(histBtn);
      }
      main.appendChild(foot);
      el.appendChild(info);
      el.appendChild(main);
      el.appendChild(hist);
      it.ctl = canEdit ? ctl : null;
      it.dom = { el: el, status: status, hist: hist, histBtn: histBtn, upd: upd, unset: unset };
      return el;
    }

    /** Redraw a row in place. A row the view no longer holds (setRows ran
     *  while its request was out) is not drawn back. */
    function redraw(it) {
      var old = it.dom && it.dom.el;
      var el = build(it);
      if (old && old.parentNode === container) container.replaceChild(el, old);
    }
    function drawAll() {
      container.textContent = '';
      if (!items.length && opts.empty) container.appendChild(mk(doc, 'div', 'ycsr-empty', opts.empty));
      items.forEach(function (it) { container.appendChild(build(it)); });
    }
    /** The server's { key, value, updated_at } after a write → the row. The
     *  control is redrawn unless it was edited while the request was out
     *  (force: always — a restore replaces any edit). */
    function adopt(it, setting, sent, force) {
      var editedSince = !force && valueOf(it) !== sent;
      it.row = Object.assign({}, it.row, {
        value: setting && typeof setting.value === 'string' ? setting.value : sent,
        updated_at: setting && setting.updated_at !== undefined ? setting.updated_at : it.row.updated_at,
        exists: true,
      });
      if (!editedSince) { redraw(it); return; }
      it.dom.el.classList.toggle('is-dirty', dirty(it));
      it.dom.upd.textContent = it.row.updated_at ? 'Updated ' + fmtWhen(it.row.updated_at) : '';
      if (it.dom.unset) it.dom.unset.hidden = true;
    }

    // ── History ──
    function toggleHistory(it) {
      if (!it.dom.hist.hidden) {
        it.dom.hist.hidden = true;
        it.dom.histBtn.setAttribute('aria-expanded', 'false');
        return Promise.resolve();
      }
      return openHistory(it);
    }
    function openHistory(it) {
      var dom = it.dom, box = dom.hist, key = it.row.key;
      box.hidden = false;
      if (dom.histBtn) dom.histBtn.setAttribute('aria-expanded', 'true');
      box.textContent = '';
      box.appendChild(mk(doc, 'div', 'ycsr-hist-title', 'History'));
      var msg = mk(doc, 'div', 'ycsr-hist-msg', 'Loading…');
      box.appendChild(msg);
      return Promise.resolve()
        .then(function () { return api('/api/app-settings/' + encodeURIComponent(key) + '/history?limit=50'); })
        .then(function (r) {
          if (it.dom !== dom || box.hidden) return;
          var vs = r && Array.isArray(r.versions) ? r.versions : [];
          if (!vs.length) { msg.textContent = 'No changes recorded yet.'; return; }
          box.removeChild(msg);
          vs.forEach(function (v) { box.appendChild(versionEl(it, v)); });
        }, function (e) {
          if (it.dom === dom) msg.textContent = errMsg(e, 'Could not load the history');
        });
    }
    function valEl(x) {
      if (x == null) return mk(doc, 'span', 'ycsr-val ycsr-val-none', '(not set)');
      if (x === '') return mk(doc, 'span', 'ycsr-val ycsr-val-none', '(blank)');
      return mk(doc, 'span', 'ycsr-val', '“' + short(String(x)) + '”');
    }
    function versionEl(it, v) {
      var d = mk(doc, 'div', 'ycsr-ver');
      d.setAttribute('data-ver', String(v.id));
      var who = v.changed_by_name || (v.changed_by != null ? 'user #' + v.changed_by : 'automation');
      var line = mk(doc, 'div', 'ycsr-ver-line');
      line.appendChild(doc.createTextNode('changed '));
      line.appendChild(valEl(v.old_value));
      line.appendChild(doc.createTextNode(' → '));
      line.appendChild(valEl(v.new_value));
      line.appendChild(doc.createTextNode(' by ' + who + ', ' + fmtWhen(v.changed_at) + ', ' +
        (Object.prototype.hasOwnProperty.call(VIA, v.changed_via) ? VIA[v.changed_via] : String(v.changed_via == null ? '' : v.changed_via))));
      d.appendChild(line);
      var oldv = v.old_value == null ? '' : String(v.old_value);
      if (oldv === stored(it.row)) {
        d.appendChild(mk(doc, 'span', 'yc-hint ycsr-ver-cur', 'The value before this change is the current one.'));
      } else {
        var b = button(doc, 'btn btn-outline btn-sm', 'Restore this value');
        b.setAttribute('data-ycsr', 'restore');
        b.addEventListener('click', function () { restore(it, v, b); });
        d.appendChild(b);
      }
      return d;
    }
    /** Put back the value an entry REPLACED (its old_value; null → blank). */
    function restore(it, v, btn) {
      var oldv = v.old_value == null ? '' : String(v.old_value);
      var text = (it.row.label || it.row.key) + ' goes back to ' + (oldv === '' ? 'blank' : '“' + short(oldv) + '”') +
        ' — a new entry in History.' + (dirty(it) ? ' Your unsaved change to it is discarded.' : '');
      return Promise.resolve()
        .then(function () { return confirmFn('Restore this value?', text); })
        .then(function (ok) {
          if (!ok) return;
          btn.disabled = true;
          return Promise.resolve()
            .then(function () { return api('/api/app-settings/' + encodeURIComponent(it.row.key) + '/restore', 'POST', { version_id: v.id }); })
            .then(function (r) {
              adopt(it, r && r.setting, oldv, true);          // the restored value replaces any edit
              setStatus(it, 'Restored', 'ok');
              if (isFe(it.row.key)) refreshFirmData(doc.defaultView);
              onDirty();
              return openHistory(it);
            }, function (e) {
              btn.disabled = false;
              setStatus(it, errMsg(e, 'Restore failed'), 'err');
            });
        });
    }

    // ── save ──
    async function saveAll() {
      var res = { ok: true, saved: [], failed: [], errors: {} };
      var list = items.filter(dirty);
      for (var i = 0; i < list.length; i++) {
        var it = list[i], key = it.row.key;
        var prob = it.ctl.problem ? it.ctl.problem() : null;
        if (prob) {
          res.failed.push(key);
          res.errors[key] = { status: null, message: prob };
          setStatus(it, prob, 'err');
          continue;
        }
        var sent = it.ctl.get();
        setStatus(it, 'Saving…', '');
        try {
          var r = await api('/api/app-settings/' + encodeURIComponent(key), 'PUT', { value: sent });
          adopt(it, r && r.setting, sent);
          setStatus(it, 'Saved', 'ok');
          res.saved.push(key);
        } catch (e) {
          var m = errMsg(e, 'Save failed');
          res.failed.push(key);
          res.errors[key] = { status: e && e.status != null ? e.status : null, message: m };
          setStatus(it, m, 'err');
        }
      }
      res.ok = res.failed.length === 0;
      if (res.saved.some(isFe)) refreshFirmData(doc.defaultView);   // once per batch
      onDirty();
      return res;
    }

    function make(row) { return { row: Object.assign({}, row), ctl: null, dom: null }; }
    function find(key) { return items.filter(function (it) { return it.row.key === key; })[0]; }

    items = (Array.isArray(opts.rows) ? opts.rows : []).map(make);
    drawAll();

    return {
      isDirty: function () { return items.some(dirty); },
      dirtyKeys: function () { return items.filter(dirty).map(function (it) { return it.row.key; }); },
      value: function (key) { var it = find(key); return it ? valueOf(it) : undefined; },
      save: function () {
        if (!saving) saving = saveAll().then(function (r) { saving = null; return r; }, function (e) { saving = null; throw e; });
        return saving;
      },
      setRows: function (rows) {
        items = (Array.isArray(rows) ? rows : []).map(make);
        drawAll();
        onDirty();
      },
      addRow: function (row) {
        var it = make(row);
        if (!items.length) container.textContent = '';
        items.push(it);
        container.appendChild(build(it));
        onDirty();
      },
      rows: function () { return items.map(function (it) { return Object.assign({}, it.row); }); },
      get ready() { return Promise.all(pending).then(noop); },
    };
  }

  var ycSettingRows = { create: create, lookups: lookups, wsHint: wsHint };
  root.ycSettingRows = ycSettingRows;
  if (typeof module !== 'undefined' && module.exports) module.exports = ycSettingRows;
})(typeof window !== 'undefined' ? window : this);
