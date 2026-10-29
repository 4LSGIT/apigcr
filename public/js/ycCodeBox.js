/* public/js/ycCodeBox.js — the Code dialog: run JavaScript in the shell, as if
 * it were typed into the browser console.
 *
 *   window.ycCodeBox.open()    opens/resumes the local draft (no arguments)
 *   window.ycCodeBox.close()   closes it (a running snippet keeps running)
 *   window.ycCodeBox.isOpen()  → boolean
 *   window.openCodeBox()       the page call the launcher's `code` item makes
 *                              (featureRegistry.js; index.html NO_ELEMENT)
 *
 * WHY it is open to all staff: the code runs as the signed-in user, in the
 * shell, with the shell's apiSend — exactly what the browser console already
 * gives anyone who opens it. It grants no access the user lacks; the server
 * judges every request. It is hidden (in no default layout: Ctrl-K → "code",
 * or a user's own shortcut / placement) because it is advanced, not because
 * it is privileged.
 *
 * Three rules that keep it no worse than the console:
 *   1. A fresh draft is EMPTY. Nothing fills it — no URL parameter, no launcher or
 *      firm action, no other page or frame. Code arrives only by the user
 *      typing or pasting it. Close preserves that draft in memory; only Clear
 *      or a page reload discards it. A remotely pre-filled box is one click from a link, i.e.
 *      a cross-user attack; the console has no such door, and neither may this.
 *   2. Run is the user's own act: the Run button or Ctrl/⌘+Enter, never on
 *      paste or on open.
 *   3. Audited first: the code is posted to /api/code-box/runs
 *      (routes/api.codeBox.js → admin_audit_log, tool 'code_box') BEFORE it
 *      runs, and nothing runs unless that answers success. The requests a
 *      snippet makes are logged anyway (jwt_api_audit_log); this records the
 *      snippet itself, and is the only trace of one that reads the session
 *      token and sends it elsewhere.
 *
 * How it runs: compiled as an async function in the page's global scope, so
 * `await apiSend(...)` works and every page function is in reach. A single
 * expression shows its value (like the console: `1 + 1` → 2); anything else
 * runs as statements and shows what it `return`s. Variables do not survive
 * between runs (use window.x to keep one). The value is shown as JSON where
 * it can be (cycles, Maps, Sets, Errors and elements made readable), capped
 * at OUT_MAX characters on screen; Copy output copies all of it. A snippet
 * cannot be stopped once it runs — the same as the console. Close only hides
 * the dialog; reopening resumes the same draft, output and running state.
 * Each run gets a local console wrapper: log/info/warn/error/debug,
 * dir/dirxml/table/trace and assert appear live here and in DevTools;
 * console.clear clears captured messages. window.console is never replaced.
 * Console text is capped at OUT_MAX; Copy includes all retained text plus
 * the result. The server row is finished with browser-reported success/error
 * and duration (never output); a failed finish leaves the original run row.
 *
 * Draws in the shell document. z-index 1052: above the palette (1050), the
 * layout editor (1045) and the tool dialog (1040); below the icon picker
 * (1055) and SweetAlert2 (1060) — a snippet's own dialogs and toasts appear
 * on top of it. Keys typed inside it stop at its root (no launcher shortcut
 * or Ctrl-K fires from the editor) and Tab cycles inside it. While it is open
 * a capture-phase guard on the document stops any key aimed BEHIND it (focus
 * fallen to <body> or the shell: Esc closes, anything else puts focus back in
 * the editor) — except keys aimed at a SweetAlert (.swal2-container), which a
 * snippet's own dialog must still get.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var CODE_MAX = 65536;            // characters; routes/api.codeBox.js CODE_MAX
  var OUT_MAX = 200000;            // characters drawn; Copy output takes them all
  var AUDIT_URL = '/api/code-box/runs';
  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  var MAC = /Mac|iPhone|iPad/.test((navigator && navigator.platform) || '');

  var D = null;                    // the DOM, built on first open
  var S = null;                    // draft/run retained until Clear or page reload

  // ── evaluation (pure) ────────────────────────────────────────────────
  /** Compile code as an async function: one expression returns its value;
   *  otherwise the code is the body. Throws the body's SyntaxError. */
  function compile(code) {
    var expr = String(code), end = expr.length;
    while (end > 0 && /[\s;]/.test(expr.charAt(end - 1))) end--;   // a loop: the regex form is quadratic on long runs
    expr = expr.slice(0, end);
    try {
      return { fn: new AsyncFunction('console', 'return (async function(){ return (' + expr + '\n); }).call(this);'), expr: true };
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
    return { fn: new AsyncFunction('console', 'return (async function(){\n' + code + '\n}).call(this);'), expr: false };
  }

  // Duck-typed, not instanceof: a value made in a pane's frame is another
  // realm's Map / Error / element.
  function tagOf(x) { return Object.prototype.toString.call(x); }
  function isNode(x) { return !!x && typeof x === 'object' && typeof x.nodeType === 'number' && typeof x.nodeName === 'string'; }
  function nodeLabel(x) { return '<' + String(x.nodeName).toLowerCase() + (x.id ? '#' + x.id : '') + '>'; }

  /** A value as readable text: strings as they are, everything else as JSON
   *  where possible. */
  function format(v) {
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && !isFinite(v)) return String(v);
    if (typeof v === 'function') return 'function ' + (v.name || '(anonymous)') + '()';
    if (typeof v === 'bigint') return String(v) + 'n';
    if (typeof v === 'symbol') return String(v);
    if (isNode(v)) return nodeLabel(v);
    var stack = [];                          // the ancestors of the value being written: a repeat is not a cycle
    try {
      var s = JSON.stringify(v, function (k, x) {
        while (stack.length && stack[stack.length - 1] !== this) stack.pop();
        if (typeof x === 'bigint') return String(x) + 'n';
        if (typeof x === 'number' && !isFinite(x)) return String(x);
        if (typeof x === 'function') return 'function ' + (x.name || '(anonymous)') + '()';
        if (!x || typeof x !== 'object') return x;
        if (isNode(x)) return nodeLabel(x);
        var tag = tagOf(x);
        if (tag === '[object Error]') return { name: x.name, message: x.message };
        if (tag === '[object Map]') x = { Map: Array.from(x.entries()) };
        else if (tag === '[object Set]') x = { Set: Array.from(x.values()) };
        else if (stack.indexOf(x) >= 0) return '[Circular]';
        stack.push(x);
        return x;
      }, 2);
      return s === undefined ? String(v) : s;
    } catch (_) {
      try { return String(v); } catch (__) { return '[unprintable value]'; }
    }
  }

  /** An error as readable text; an apiSend ApiError also shows its HTTP
   *  status and response body. Duck-typed, not instanceof: an error made in a
   *  pane's frame is another realm's Error. */
  function formatError(e) {
    if (!e || typeof e !== 'object' || typeof e.message !== 'string') return 'Thrown: ' + format(e);
    var out = e.stack && e.stack.indexOf(e.message) >= 0 ? String(e.stack) : e.name + ': ' + e.message;
    if (e.name === 'ApiError') {
      out = 'ApiError: ' + e.message + '\n' + (e.method || '') + ' ' + (e.url || '') + ' → HTTP ' + e.status;
      if (e.body) out += '\n' + format(e.body);
    }
    return out;
  }

  // ── DOM ──────────────────────────────────────────────────────────────
  var CSS = [
    '#ycCodeBox { position: fixed; inset: 0; z-index: 1052; display: flex; align-items: flex-start; justify-content: center;',
    '  padding: 6vh 16px 16px; box-sizing: border-box; }',
    '#ycCodeBox[hidden] { display: none; }',
    '#ycCodeBox .ycb-back { position: absolute; inset: 0; background: var(--backdrop); }',
    '#ycCodeBox .ycb-box { position: relative; display: flex; flex-direction: column; width: 760px; max-width: 100%;',
    '  max-height: 88vh; min-height: 0; box-sizing: border-box; overflow: hidden; text-align: left;',
    '  font-family: var(--ui); background: var(--surface); color: var(--text); border: 1px solid var(--border-strong);',
    '  border-radius: var(--radius); box-shadow: var(--shadow-drawer); outline: none; }',
    '#ycCodeBox .ycb-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; min-width: 0;',
    '  padding: 6px 6px 6px 16px; border-bottom: 1px solid var(--border); }',
    '#ycCodeBox .ycb-head h2 { flex: 1 1 auto; min-width: 0; margin: 0; font-size: var(--fs-lg); font-weight: 600; color: var(--text); }',
    '#ycCodeBox .ycb-x { flex: 0 0 auto; width: var(--ctl-h); height: var(--ctl-h); min-width: 0; margin: 0; padding: 0;',
    '  cursor: pointer; font-size: var(--fs); background: transparent; color: var(--text-muted); border: 0;',
    '  border-radius: var(--radius-sm); }',
    '#ycCodeBox .ycb-warn { flex: 0 0 auto; display: flex; gap: 8px; align-items: flex-start; margin: 10px 16px 0; padding: 8px 10px;',
    '  font-size: var(--fs-sm); line-height: 1.4; color: var(--text); background: var(--warn-soft);',
    '  border: 1px solid var(--border-strong); border-left: 3px solid var(--warn-fill); border-radius: var(--radius-sm);',
    '  overflow-wrap: anywhere; }',
    '#ycCodeBox .ycb-warn i { flex: 0 0 auto; margin-top: 2px; color: var(--warn); }',
    '#ycCodeBox .ycb-body { flex: 1 1 auto; display: flex; flex-direction: column; gap: 8px; min-height: 0; padding: 10px 16px; }',
    '#ycCodeBox textarea.ycb-code { flex: 0 0 auto; display: block; width: 100%; height: 220px; min-height: 120px; margin: 0;',
    '  padding: 8px 10px; box-sizing: border-box; resize: vertical; font-family: var(--mono);',
    '  font-size: 13px; line-height: 1.45; tab-size: 2; white-space: pre; overflow: auto; background: var(--surface); color: var(--text);',
    '  border: 1px solid var(--border-strong); border-radius: var(--radius-sm); }',
    '#ycCodeBox textarea.ycb-code:focus { border-color: var(--accent); outline: 2px solid var(--accent-soft); }',
    '#ycCodeBox .ycb-status { flex: 0 0 auto; font-size: var(--fs-sm); color: var(--text-muted); overflow-wrap: anywhere; }',
    '#ycCodeBox .ycb-status:empty { display: none; }',
    '#ycCodeBox .ycb-out { flex: 1 1 auto; min-height: 0; max-height: 40vh; margin: 0; padding: 8px 10px; overflow: auto;',
    '  box-sizing: border-box; font-family: var(--mono); font-size: 12px; line-height: 1.45;',
    '  white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-sunken); color: var(--text);',
    '  border: 1px solid var(--border); border-radius: var(--radius-sm); }',
    '#ycCodeBox .ycb-out[hidden] { display: none; }',
    '#ycCodeBox .ycb-out.is-error { color: var(--danger); border-color: var(--danger); }',
    '#ycCodeBox .ycb-foot { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;',
    '  padding: 8px 16px; border-top: 1px solid var(--border); }',
    '#ycCodeBox .ycb-hint { flex: 1 1 160px; min-width: 0; font-size: var(--fs-sm); color: var(--text-muted); overflow-wrap: anywhere; }',
    '#ycCodeBox .ycb-btn { height: var(--ctl-h); min-width: 0; margin: 0; padding: 0 14px; cursor: pointer; font-size: var(--fs-sm);',
    '  background: var(--surface); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); }',
    '#ycCodeBox .ycb-btn[hidden] { display: none; }',
    '#ycCodeBox .ycb-btn:disabled { opacity: .55; cursor: default; }',
    '#ycCodeBox .ycb-run { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 600; }',
    '#ycCodeBox .ycb-x:hover, #ycCodeBox .ycb-btn:not(.ycb-run):not(:disabled):hover { background: var(--hover); color: var(--text); }',
    '#ycCodeBox .ycb-x:focus-visible, #ycCodeBox .ycb-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }',
    '@media (max-width: 768px) {',
    '  #ycCodeBox { padding: 0; }',
    '  #ycCodeBox .ycb-box { width: 100%; height: 100%; max-width: none; max-height: none; border: 0; border-radius: 0;',
    '    padding-bottom: env(safe-area-inset-bottom); }',
    '  #ycCodeBox .ycb-warn { margin: 8px 12px 0; }',
    '  #ycCodeBox .ycb-body, #ycCodeBox .ycb-foot { padding-left: 12px; padding-right: 12px; }',
    '  #ycCodeBox textarea.ycb-code { height: 160px; }',
    '}',
  ].join('\n');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(cls, text, act) {
    var b = el('button', cls, text);
    b.type = 'button';
    if (act) b.setAttribute('data-ycb', act);
    return b;
  }

  function ensureDom() {
    if (D && D.root.isConnected) return D;
    if (!document.getElementById('ycCodeBoxCss')) {
      var st = el('style');
      st.id = 'ycCodeBoxCss';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var root = el('div');
    root.id = 'ycCodeBox';
    root.hidden = true;
    var back = el('div', 'ycb-back');
    var box = el('div', 'ycb-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'ycbTitle');
    box.tabIndex = -1;
    var head = el('div', 'ycb-head');
    var h = el('h2', null, 'Code');
    h.id = 'ycbTitle';
    var x = button('ycb-x', null, 'close');
    x.setAttribute('aria-label', 'Close');
    x.appendChild(el('i', 'fa-solid fa-xmark'));
    head.appendChild(h);
    head.appendChild(x);
    var warn = el('div', 'ycb-warn');
    warn.setAttribute('role', 'note');
    warn.appendChild(el('i', 'fa-solid fa-triangle-exclamation'));
    warn.appendChild(el('span', null,
      'Code here runs as you, with everything your login can do — like the browser console. '
      + 'Only run code from someone you trust at the firm. Never paste code sent in an email or text, '
      + 'found on a website, or read to you by a caller: anyone asking you to do that is attempting a scam. '
      + 'Every run is recorded.'));
    var body = el('div', 'ycb-body');
    var ta = el('textarea', 'ycb-code');
    ta.setAttribute('aria-label', 'Code to run');
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('wrap', 'off');
    ta.placeholder = "await apiSend('/api/…')";
    var status = el('div', 'ycb-status');
    status.setAttribute('aria-live', 'polite');
    var out = el('pre', 'ycb-out');
    out.hidden = true;
    out.tabIndex = 0;
    out.setAttribute('aria-label', 'Result');
    body.appendChild(ta);
    body.appendChild(status);
    body.appendChild(out);
    var foot = el('div', 'ycb-foot');
    var hint = el('span', 'ycb-hint', (MAC ? '⌘' : 'Ctrl') + '+Enter runs. More than one statement? End with return x to see x.');
    var copy = button('ycb-btn ycb-copy', 'Copy output', 'copy');
    copy.hidden = true;
    var clear = button('ycb-btn ycb-clear', 'Clear', 'clear');
    var close = button('ycb-btn ycb-close', 'Close', 'close');
    var run = button('ycb-btn ycb-run', 'Run', 'run');
    foot.appendChild(hint);
    foot.appendChild(copy);
    foot.appendChild(clear);
    foot.appendChild(close);
    foot.appendChild(run);
    box.appendChild(head);
    box.appendChild(warn);
    box.appendChild(body);
    box.appendChild(foot);
    root.appendChild(back);
    root.appendChild(box);
    document.body.appendChild(root);

    root.addEventListener('keydown', onKey);
    root.addEventListener('click', onClick);
    // a press on the backdrop never blurs the editor, and never closes the
    // dialog: a stray click must not throw away pasted code
    back.addEventListener('mousedown', function (e) { e.preventDefault(); });
    D = { root: root, box: box, ta: ta, status: status, out: out, copy: copy, clear: clear, run: run };
    return D;
  }

  // ── the session ──────────────────────────────────────────────────────
  // No parameters, on purpose (rule 1 above): whatever a caller passes is
  // ignored. Only the current local draft may be resumed.
  function open() {
    ensureDom();
    if (S) {
      if (D.root.hidden) S.from = document.activeElement;
      D.root.hidden = false;
      document.addEventListener('keydown', onGuardKey, true);
      D.ta.focus();
      return;
    }
    S = { running: false, text: '', from: document.activeElement };
    D.ta.value = '';
    D.status.textContent = '';
    D.out.textContent = '';
    D.out.hidden = true;
    D.out.classList.remove('is-error');
    D.copy.hidden = true;
    D.run.disabled = false;
    D.clear.disabled = false;
    D.root.hidden = false;
    document.addEventListener('keydown', onGuardKey, true);
    D.ta.focus();
  }

  function close() {
    if (!S || D.root.hidden) return;
    var s = S;
    document.removeEventListener('keydown', onGuardKey, true);
    D.root.hidden = true;
    try {
      if (s.from && s.from.isConnected && typeof s.from.focus === 'function') s.from.focus();
    } catch (_) { /* gone */ }
  }

  function clear() {
    if (!S || S.running) return;
    var from = S.from;
    S = null;
    open();
    S.from = from;
  }

  function setStatus(t) { D.status.textContent = t; }

  // Each snippet receives its own console. Never replace window.console:
  // unrelated app logs must not appear here or be attributed to this run.
  // Snapshots are bounded; callbacks from a previous run cannot change a new
  // run's output. Messages still go to the browser's original console too.
  function runConsole(mine, run) {
    var native = window.console;
    var local = Object.create(native);
    function emit(level, args) {
      if (S !== mine || mine.run !== run || run.truncated) return;
      var line = '[' + level + '] ' + Array.from(args).map(format).join(' ') + '\n';
      var notice = '\n… console output limit reached; further messages are omitted.\n';
      var room = OUT_MAX - notice.length - run.logs.length;
      run.logs += line.slice(0, room);
      if (line.length > room) {
        run.logs += notice;
        run.truncated = true;
      }
      renderRun(run);
    }
    ['log', 'info', 'warn', 'error', 'debug', 'dir', 'dirxml', 'table', 'trace'].forEach(function (name) {
      local[name] = function () {
        if (typeof native[name] === 'function') native[name].apply(native, arguments);
        emit(name, arguments);
      };
    });
    local.assert = function (condition) {
      if (typeof native.assert === 'function') native.assert.apply(native, arguments);
      if (!condition) emit('assert', arguments.length > 1 ? Array.from(arguments).slice(1) : ['Assertion failed']);
    };
    local.clear = function () {
      if (S !== mine || mine.run !== run) return;
      run.logs = '';
      run.truncated = false;
      renderRun(run);
    };
    return local;
  }

  function renderRun(run) {
    show(run.logs + (run.result === null ? '' : (run.logs ? '\n' : '') + run.result), run.error);
  }

  function show(text, isError) {
    S.text = text;
    D.out.textContent = text.length > OUT_MAX
      ? text.slice(0, OUT_MAX) + '\n… ' + (text.length - OUT_MAX) + ' more characters (Copy output takes them all)'
      : text;
    D.out.classList.toggle('is-error', !!isError);
    D.out.hidden = false;
    D.copy.hidden = false;
  }

  async function run() {
    if (!S || S.running) return;
    var mine = S;
    var code = D.ta.value;
    if (!code.trim()) { setStatus('Type or paste some code first.'); return; }
    if (code.length > CODE_MAX) { setStatus('Too long: ' + code.length + ' characters (the limit is ' + CODE_MAX + ').'); return; }
    mine.run = null;                       // retire prior callbacks, even on a syntax error
    var compiled;
    try {
      compiled = compile(code);
    } catch (e) {
      setStatus(e && e.name === 'SyntaxError' ? 'Not run: the code has a syntax error.' : 'Not run: the code could not be compiled.');
      show(formatError(e), true);
      return;
    }
    mine.running = true;
    var run = mine.run = { logs: '', result: null, error: false, truncated: false };
    D.out.hidden = true;
    D.copy.hidden = true;
    mine.text = '';
    D.run.disabled = true;
    D.clear.disabled = true;
    setStatus('Recording the run…');
    var r;
    try {
      r = await window.apiSend(AUDIT_URL, 'POST', { code: code });
      if (!r || r.status !== 'success') throw new Error('unexpected answer from ' + AUDIT_URL);
    } catch (e) {
      if (S === mine) {
        mine.running = false;
        D.run.disabled = false;
        D.clear.disabled = false;
        setStatus('Not run: the run could not be recorded.');
        show(formatError(e), true);
      }
      return;
    }
    if (S !== mine) return;
    setStatus('Running…');
    var t0 = Date.now();
    var ok = true, value;
    try {
      value = await compiled.fn.call(window, runConsole(mine, run));
    } catch (e) {
      ok = false;
      value = e;
    }
    var duration = Math.min(2147483647, Math.max(0, Date.now() - t0));
    run.error = !ok;
    run.result = ok ? format(value) : formatError(value);
    renderRun(run);
    var message = (ok ? 'Done' : 'Threw an error') + ' in ' + duration + ' ms.';
    mine.running = false;
    D.run.disabled = false;
    D.clear.disabled = false;
    setStatus(message + ' Recording outcome…');
    // Outcome is best-effort AFTER execution: failure must never run the
    // snippet again or hide its result. Old servers have no run_id yet.
    try {
      if (!Number.isSafeInteger(r.run_id) || r.run_id < 1) throw new Error('Missing run id');
      var finished = await window.apiSend(AUDIT_URL + '/' + r.run_id + '/finish', 'POST', {
        status: ok ? 'success' : 'error', duration_ms: duration,
      });
      if (!finished || finished.status !== 'success') throw new Error('Outcome not recorded');
    } catch (_) {
      message += ' Completion could not be recorded.';
    }
    if (S === mine && mine.run === run) setStatus(message);
  }

  function copyOutput() {
    if (!S) return;
    var text = S.text;
    var done = function () { setStatus('Output copied.'); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { setStatus('Copy failed — select the output and copy it.'); });
        return;
      }
    } catch (_) { /* fall through */ }
    setStatus('Copy is not available here — select the output and copy it.');
  }

  // ── events ───────────────────────────────────────────────────────────
  function focusables() {
    var list = [D.root.querySelector('.ycb-x'), D.ta];
    if (!D.out.hidden) list.push(D.out);
    if (!D.copy.hidden) list.push(D.copy);
    if (!D.clear.disabled) list.push(D.clear);
    list.push(D.root.querySelector('.ycb-close'));
    if (!D.run.disabled) list.push(D.run);
    return list;
  }

  /** The document's capture-phase guard, present only while open: a key
   *  aimed BEHIND the dialog never reaches the page (Ctrl-K, a user's
   *  shortcut) — Esc closes, anything else puts focus back in the editor.
   *  Keys inside the dialog go on to onKey; keys aimed at a SweetAlert a
   *  snippet opened go on to it. */
  function onGuardKey(e) {
    var t = e.target;
    if (D.root.contains(t)) return;
    if (t && t.closest && t.closest('.swal2-container')) return;
    e.stopPropagation();
    if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') e.preventDefault();
    D.ta.focus();
  }

  function onKey(e) {
    // nothing behind the dialog hears a key typed in it (Ctrl-K, shortcuts)
    e.stopPropagation();
    if (!S) return;
    if (e.key === 'Escape') {
      if (e.isComposing) return;               // an IME is composing: its Esc, not ours
      e.preventDefault(); close(); return;
    }
    if (e.key === 'Tab') {                     // modal: Tab cycles inside the dialog
      var f = focusables(), at = f.indexOf(document.activeElement);
      e.preventDefault();
      f[at < 0 ? 0 : (at + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      run();
    }
  }

  function onClick(e) {
    if (!S) return;
    var t = e.target.closest ? e.target.closest('button') : null;
    if (!t || !D.root.contains(t)) return;
    var act = t.getAttribute('data-ycb');
    if (act === 'close') close();
    else if (act === 'run') run();
    else if (act === 'copy') copyOutput();
    else if (act === 'clear') clear();
  }

  window.ycCodeBox = Object.freeze({
    open: open,
    close: close,
    isOpen: function () { return !!S && !D.root.hidden; },
    _compile: compile,
    _format: format,
    CODE_MAX: CODE_MAX,
  });
  window.openCodeBox = function openCodeBox() { open(); };
})();
