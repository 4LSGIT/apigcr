// public/js/ycNoTranscribe.js
//
/**
 * The do-not-transcribe dialog (comms archive, design §0 R9 / P6) — ONE copy,
 * hosted by every pane that offers it:
 *   - public/connections.html — Phone Lines → Do-not-transcribe (SU-only page);
 *   - public/comms.html — the Phone tab's admin-tools slot (archive admins).
 *
 *   window.ycNoTranscribe.open({ api, firmData })
 *     api       the host's transport, called as api(url[, method, payload]) →
 *               Promise of the parsed body, rejecting with an Error whose
 *               message is shown — i.e. the shell's apiSend, reached through
 *               the pane's window.parent (panes never read the token).
 *     firmData  the shell's firmData (users + currentUser) for "Requested by";
 *               read at open, so a later firmData load is picked up next open.
 *
 * comms_no_transcribe through /api/comms-archive/no-transcribe
 * (routes/api.commsArchive.js — staff JWT + archive admin: SU, or listed in
 * app_settings comms_archive_admins; the server is the gate, every outcome is
 * audited). A host's own button gate is cosmetic; a 403 from the list shows in
 * the dialog. Add and ✕ act at once (✕ asks first) — the dialog holds nothing
 * unsaved, so Close loses nothing. "Requested by" = who asked (any active
 * staff member, default the signed-in admin); the audit row records who added
 * it. Not a sync-bus entity: the dialog repaints from each response. Every
 * outcome shows in the dialog (no toast).
 *
 * SELF-CONTAINED. The first open injects the <dialog id="noTxDialog"> into the
 * host's body and its CSS (<style id="ycNoTxStyle">) into its head. Every rule
 * is scoped through #noTxDialog, so it wins on SPECIFICITY over whatever the
 * host loads — never by load order (CLAUDE.md: scripts.js injects dialog CSS
 * before style.css, and style.css's global input rule is 0,2,1; an id beats
 * it). The dialog brings its whole look (box, buttons, inputs, table), so it
 * reads the same on hosts with different page CSS; theme.css tokens only.
 *
 * DOM from data is TEXT: every value is written through textContent (h()); no
 * markup is built from strings here (comms.html's sink rule — the sinks test
 * in tests/mailboxS2.render.test.js greps this file too).
 *
 * Tests: tests/commsNoTranscribe.pane.test.js (both hosts).
 */
(function () {
  'use strict';

  const ID = 'noTxDialog';
  const STYLE_ID = 'ycNoTxStyle';
  const PATH = '/api/comms-archive/no-transcribe';

  const CSS = `
#noTxDialog {
  background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px;
  padding: 16px; box-sizing: border-box; min-width: 0; width: min(680px, calc(100vw - 24px)); max-width: calc(100vw - 24px);
  font-family: -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 13px;
}
#noTxDialog *, #noTxDialog *::before, #noTxDialog *::after { box-sizing: border-box; }
#noTxDialog::backdrop { background: var(--backdrop); }
#noTxDialog h3 { margin: 0 0 10px 0; font-size: 14px; }
/* .yc-flabel / .yc-hint: the shared label / hint look (AI_CONTEXT §12), restated so every host matches */
#noTxDialog .yc-flabel { display: block; font-size: var(--fs-sm); font-weight: 700; color: var(--text); margin: 0 0 4px; }
#noTxDialog .yc-hint { display: block; font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); margin: 0 0 12px; line-height: 1.45; }
#noTxDialog input, #noTxDialog select {
  width: 100%; min-width: 0; padding: 6px 8px; background: var(--page-bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 4px; font-size: 12px; font-family: inherit;
}
#noTxDialog .btn {
  display: inline-block; background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
  border-radius: 4px; padding: 6px 12px; cursor: pointer; font-size: 12px; font-family: inherit; font-weight: 400;
  line-height: normal; white-space: nowrap; flex-shrink: 0; transition: border-color 0.12s, background 0.12s;
}
#noTxDialog .btn:hover { border-color: var(--accent); }
#noTxDialog .btn.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 600; }
#noTxDialog .btn.primary:hover { filter: brightness(1.08); }
#noTxDialog .btn:disabled { opacity: 0.5; cursor: not-allowed; }
#noTxDialog .actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 12px; }
#noTxDialog .result { margin-top: 10px; font-size: 12px; }
#noTxDialog .result.ok { color: var(--ok); }
#noTxDialog .result.err { color: var(--danger); }
#noTxDialog .notx-add { display: flex; flex-wrap: wrap; gap: 8px 10px; align-items: flex-end; }
#noTxDialog .notx-add .f { display: flex; flex-direction: column; min-width: 0; }
#noTxDialog .notx-add .f-phone { flex: 1 1 130px; }
#noTxDialog .notx-add .f-note { flex: 3 1 170px; }
#noTxDialog .notx-add .f-by { flex: 1 1 140px; }
#noTxDialog .notx-scroll { overflow: auto; max-height: 45vh; margin-top: 12px; }
#noTxDialog table.list { width: 100%; border-collapse: collapse; font-size: 12px; border: 1px solid var(--border); background: var(--surface); }
#noTxDialog table.list th, #noTxDialog table.list td { border-bottom: 1px solid var(--border); padding: 7px 10px; text-align: left; vertical-align: middle; }
#noTxDialog table.list th {
  background: var(--surface-2); color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em; font-size: 10.5px; font-weight: 600;
}
#noTxDialog table.list tbody tr { cursor: default; }
#noTxDialog table.list tbody tr:hover { background: var(--surface-2); }
#noTxDialog table.list tr.empty-row td { color: var(--text-muted); padding: 16px; text-align: center; font-style: italic; }
#noTxDialog table.list td.notx-note { overflow-wrap: anywhere; min-width: 9em; }   /* the table scrolls in its box before a note goes one letter wide */
#noTxDialog table.list td.notx-num { white-space: nowrap; }
#noTxDialog table.list th.notx-xcol { width: 34px; }
#noTxDialog .notx-x {
  background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border);
  border-radius: 4px; padding: 2px 7px; font-size: 11px; cursor: pointer; font-family: inherit;
}
#noTxDialog .notx-x:hover { border-color: var(--danger); color: var(--danger); }
`;

  const st = { entries: [], busy: false, api: null, firmData: null };
  const E = (id) => document.getElementById(id);

  /** Strings become TEXT nodes; attrs are plain attributes (className / dataset handled). */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'className') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function fmtPhone(p) {
    return p && /^\d{10}$/.test(p) ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : (p || '—');
  }

  function say(text, kind = '') {
    const el = E('noTxMsg');
    el.className = 'result' + (kind ? ' ' + kind : '');
    el.textContent = text || '';
  }

  /** The dialog and its CSS, built once per document. */
  function ensure() {
    if (!E(STYLE_ID)) {
      const s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    let dlg = E(ID);
    if (dlg) return dlg;
    dlg = h('dialog', { id: ID },
      h('h3', null, 'Do-not-transcribe numbers'),
      h('span', { className: 'yc-hint' },
        'Calls with a listed number are still archived and playable, but are not sent for transcription, '
        + "so they get no AI summary either (a voicemail can still show the phone provider's own transcript). "
        + 'Adding a number does not touch transcripts that already exist, and those are still summarised; to hide or delete one, '
        + 'Restrict or Purge the call. Removing a number lets future calls be transcribed; calls already skipped stay skipped.'),
      h('div', { className: 'notx-add' },
        h('div', { className: 'f f-phone' },
          h('label', { className: 'yc-flabel', for: 'noTxPhone' }, 'Phone'),
          h('input', { id: 'noTxPhone', type: 'text', maxlength: '20', inputmode: 'tel', autocomplete: 'off', placeholder: '2485551234' })),
        h('div', { className: 'f f-note' },
          h('label', { className: 'yc-flabel', for: 'noTxNote' }, 'Reason'),
          h('input', { id: 'noTxNote', type: 'text', maxlength: '255', autocomplete: 'off', placeholder: '(optional)' })),
        h('div', { className: 'f f-by' },
          h('label', { className: 'yc-flabel', for: 'noTxBy' }, 'Requested by'),
          h('select', { id: 'noTxBy' })),
        h('button', { className: 'btn primary', id: 'noTxAdd', type: 'button' }, 'Add')),
      h('div', { className: 'result', id: 'noTxMsg' }),
      h('div', { className: 'notx-scroll' },
        h('table', { className: 'list' },
          h('thead', null, h('tr', null,
            h('th', { className: 'notx-xcol' }), h('th', null, 'Phone'), h('th', null, 'Note'), h('th', null, 'Requested by'))),
          h('tbody', { id: 'noTxBody' }))),
      h('div', { className: 'actions' },
        h('button', { className: 'btn', id: 'noTxClose', type: 'button' }, 'Close')));
    document.body.appendChild(dlg);

    E('noTxAdd').addEventListener('click', () => add());
    for (const id of ['noTxPhone', 'noTxNote']) {
      E(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
    }
    E('noTxBody').addEventListener('click', (ev) => {
      const b = ev.target.closest('button.notx-x');
      if (b) remove(b.dataset.id);
    });
    E('noTxClose').addEventListener('click', () => E(ID).close());
    return dlg;
  }

  /**
   * Active staff (the D3 picker rule: firmData `user_type && active !== false`), the signed-in user selected.
   * When the signed-in user is not among them (firmData not loaded, or no `user`), a leading "Me" option
   * with an empty value is selected instead: no requested_by is sent and the server records the caller.
   */
  function renderPicker() {
    const sel = E('noTxBy');
    const fd = st.firmData;
    const me = fd && fd.currentUser ? fd.currentUser.user : undefined;
    const staff = ((fd && fd.users) || []).filter((u) => u.user_type && u.active !== false);
    const meListed = me != null && staff.some((u) => String(u.user) === String(me));
    sel.replaceChildren(
      ...(meListed ? [] : [h('option', { value: '' }, 'Me')]),
      ...staff.map((u) => h('option', { value: u.user }, u.user_name || ('user ' + u.user))));
    sel.value = meListed ? String(me) : '';
  }

  const emptyRow = (text) => h('tr', { className: 'empty-row' }, h('td', { colspan: '4' }, text));

  function renderList({ loading = false } = {}) {
    const body = E('noTxBody');
    if (loading) { body.replaceChildren(emptyRow('Loading…')); return; }
    if (!st.entries.length) { body.replaceChildren(emptyRow('No numbers on the list.')); return; }
    body.replaceChildren(...st.entries.map((e) => {
      const who = e.created_by_name || (e.created_by != null ? `user #${e.created_by}` : '—');
      return h('tr', { dataset: { id: e.id } },
        h('td', null, h('button', { className: 'notx-x', type: 'button', dataset: { id: e.id }, title: 'Remove', 'aria-label': `Remove ${fmtPhone(e.phone)}` }, '✕')),
        h('td', { className: 'notx-num' }, fmtPhone(e.phone)),
        h('td', { className: 'notx-note' }, e.note || ''),
        h('td', null, who));
    }));
  }

  async function load() {
    try {
      const r = await st.api(PATH);
      st.entries = Array.isArray(r && r.entries) ? r.entries : [];
    } catch (err) {
      st.entries = [];
      say(`Couldn't load the list: ${err.message}`, 'err');
    }
    renderList();
  }

  async function open({ api, firmData } = {}) {
    if (typeof api !== 'function') throw new TypeError('ycNoTranscribe.open: api must be a function');
    st.api = api;
    st.firmData = firmData || null;
    const dlg = ensure();
    renderPicker();
    E('noTxPhone').value = '';
    E('noTxNote').value = '';
    say('');
    st.entries = [];
    renderList({ loading: true });
    if (!dlg.open) dlg.showModal();
    await load();
  }

  async function add() {
    if (st.busy) return;
    const phone = E('noTxPhone').value.trim();
    if (!phone) { say('Enter a phone number.', 'err'); return; }
    st.busy = true;
    E('noTxAdd').disabled = true;
    try {
      const r = await st.api(PATH, 'POST',
        { phone, note: E('noTxNote').value, requested_by: E('noTxBy').value || undefined });
      const entry = r && r.entry;
      if (entry) st.entries = [entry, ...st.entries.filter((x) => Number(x.id) !== Number(entry.id))];
      E('noTxPhone').value = '';
      E('noTxNote').value = '';
      say(`Added ${fmtPhone(entry && entry.phone)}.`, 'ok');
      renderList();
      E('noTxPhone').focus();
    } catch (err) {
      say(err.message, 'err');          // what was typed stays in the form
    } finally {
      st.busy = false;
      E('noTxAdd').disabled = false;
    }
  }

  async function remove(id) {
    const e = st.entries.find((x) => Number(x.id) === Number(id));
    if (!e) return;
    if (!window.confirm(`Remove ${fmtPhone(e.phone)} from the do-not-transcribe list?\n\nFuture calls with this number will be transcribed; calls already skipped stay skipped.`)) return;
    try {
      await st.api(`${PATH}/${encodeURIComponent(id)}`, 'DELETE');
      st.entries = st.entries.filter((x) => Number(x.id) !== Number(id));
      say(`Removed ${fmtPhone(e.phone)}.`, 'ok');
      renderList();
    } catch (err) {
      say(err.message, 'err');
      await load();                     // e.g. removed meanwhile elsewhere: show what is there now
    }
  }

  window.ycNoTranscribe = Object.freeze({ open });
})();
