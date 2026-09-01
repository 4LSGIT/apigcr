// ─────────────────────────────────────────────────────────────
// E-sign template-fields panel (esign workflow actions, part 3).
// public/automation/esignTplPanel.js
//
// Shared by workflows.html ('e' prefix) and sequences.html ('se' prefix) —
// same split as fnPicker.js. When the internal_function editor's selected
// function is the one this instance was built for, a panel mounts under the
// template_id field:
//
//   • A template dropdown (lazy GET /api/esign/templates) that WRITES the
//     `#<prefix>-pf-template_id` input — the input stays authoritative, the
//     dropdown is a friendly hand on it. A {{placeholder}} in the input
//     renders a "dynamic — fields can't be loaded" note instead (mirroring
//     the Slice 6R start_workflow panel's posture).
//   • Per-field rows from the selected template's prefill_schema (lazy
//     GET /api/esign/templates/:id, cached per id): label, type, required
//     marker, resolver/default hints. Each row's input two-way syncs with
//     the `values` JSON textarea (`#<prefix>-pf-values`) — the TEXTAREA
//     remains the single gathered source of truth, so the page's existing
//     metadata-driven gather needs zero changes.
//
// Sync contract with the textarea:
//   panel field edit → rebuild the textarea JSON: schema keys with non-empty
//     field values, PLUS any keys already in the textarea that the schema
//     doesn't declare (keep-then-overwrite — the server silently ignores
//     undeclared keys at send, but they are the author's text and this panel
//     never eats it). All fields empty + no extra keys → textarea cleared to
//     '' so gather deletes the param entirely.
//   textarea edit → re-populate panel fields (guarded against loops).
//   Empty panel field = "let the resolver / default fill it" — an empty
//   string is deliberately OMITTED from values, never written, because a
//   supplied '' OVERRIDES the resolver in _resolveAndInterpolate (values win
//   over resolver output) and would blank a field the author meant to
//   auto-fill.
//   Invalid JSON in the textarea: the panel won't clobber it merely by
//   rendering — but once the author EDITS a panel field, the rebuild
//   replaces the (unparseable, and therefore unsaveable anyway) text.
//
// Zero page-side state: buildEsignTplPanel returns an instance whose wire()
// is called after each editor render (same setTimeout(…, 0) timing as the
// 6R/CP-1 panels — call sites assign innerHTML synchronously, so the
// elements exist by the time the timeout fires). Caches live in the instance
// and survive across renders; a page reload naturally refreshes them.
//
// ── TWO FUNCTIONS, TWO INSTANCES, ONE SET OF ELEMENT IDS (G3) ─
// `document_generate_from_template` has the same three params this panel
// drives (template_id + values against a prefill_schema) and differs only in
// WHICH templates are offerable — contract_templates.purpose gates the two
// surfaces and each service refuses the other's templates outright. So the
// caller builds a SECOND instance with { purpose:'generate',
// fnName:'document_generate_from_template' } rather than the panel learning a
// second shape.
//
// Both instances address the SAME ids (`<prefix>-etpl-panel`,
// `<prefix>-pf-template_id`, `<prefix>-pf-values`) because the editor renders
// exactly one internal-function form at a time — see the wire sites in
// workflows.html for the invariant that makes that safe. `fnName` is what
// keeps them from fighting: render() hides the panel unless the fn selector
// currently reads this instance's own function, so the instance the page did
// not wire this render is inert even if something calls it.
// ─────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const PLACEHOLDER_RE = /\{\{[^}]+\}\}/; // mirrors lib/internal_functions PLACEHOLDER_RE

  window.buildEsignTplPanel = function buildEsignTplPanel({
    prefix, api, esc,
    purpose = 'esign',
    fnName = 'esign_send_from_template',
  }) {
    const state = {
      list: null,          // null = not loaded; [] = loaded empty
      listInflight: null,
      detail: new Map(),   // id → template (full row) | { notFound: true }
      detailInflight: new Map(),
      syncing: false,      // guards the field↔textarea two-way sync
      timer: null,
    };

    const el = (suffix) => document.getElementById(`${prefix}-${suffix}`);
    const tplInput = () => el('pf-template_id');
    const valuesTa = () => el('pf-values');
    const panel    = () => el('etpl-panel');

    // ── data ──────────────────────────────────────────────────
    async function loadList() {
      if (state.list) return state.list;
      if (state.listInflight) return state.listInflight;
      state.listInflight = (async () => {
        try {
          // Server-side purpose filter (esignTemplateService.listTemplates):
          // 'both' counts for either, so this offers exactly what the step's
          // own service will accept. The cache is per-instance, so the two
          // instances never see each other's list.
          const data = await api(`/api/esign/templates?purpose=${encodeURIComponent(purpose)}`);
          state.list = data.templates || [];
        } catch (e) {
          console.warn('esignTplPanel: template list load failed:', e.message);
          state.list = null; // retry on next render rather than caching failure
          return [];
        } finally {
          state.listInflight = null;
        }
        return state.list;
      })();
      return state.listInflight;
    }

    async function loadDetail(id) {
      if (state.detail.has(id)) return state.detail.get(id);
      if (state.detailInflight.has(id)) return state.detailInflight.get(id);
      const p = (async () => {
        try {
          const data = await api(`/api/esign/templates/${id}`);
          const result = data.template || { notFound: true };
          state.detail.set(id, result);
          return result;
        } catch (e) {
          if (e && e.status === 404) {
            const nf = { notFound: true };
            state.detail.set(id, nf);
            return nf;
          }
          return null; // transient — don't cache, don't claim not-found
        } finally {
          state.detailInflight.delete(id);
        }
      })();
      state.detailInflight.set(id, p);
      return p;
    }

    // ── values textarea helpers ───────────────────────────────
    function parseValues() {
      const ta = valuesTa();
      if (!ta) return { ok: true, values: {} };
      const raw = (ta.value || '').trim();
      if (!raw) return { ok: true, values: {} };
      try {
        const v = JSON.parse(raw);
        if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, values: v };
        return { ok: false, values: {} };
      } catch {
        return { ok: false, values: {} };
      }
    }

    function writeValuesFromFields(schema) {
      const ta = valuesTa();
      const p = panel();
      if (!ta || !p) return;
      const { values: current } = parseValues();
      const schemaKeys = new Set(schema.map((e) => e.key));

      // Keep-then-overwrite: seed with the author's out-of-schema keys.
      const next = {};
      for (const [k, v] of Object.entries(current)) {
        if (!schemaKeys.has(k)) next[k] = v;
      }
      for (const input of p.querySelectorAll(`.${prefix}-etf`)) {
        const key = input.dataset.key;
        const val = (input.value || '').trim();
        if (val !== '') next[key] = val; // empty = omit → resolver/default fills
      }

      state.syncing = true;
      ta.value = Object.keys(next).length ? JSON.stringify(next, null, 2) : '';
      // Fire input so any page-side listeners (dirty tracking etc.) react.
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      state.syncing = false;
    }

    function syncFieldsFromValues() {
      if (state.syncing) return;
      const p = panel();
      if (!p) return;
      const { ok, values } = parseValues();
      if (!ok) return; // half-typed JSON — leave the fields as they are
      for (const input of p.querySelectorAll(`.${prefix}-etf`)) {
        const v = values[input.dataset.key];
        input.value = v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v));
      }
    }

    // ── render ────────────────────────────────────────────────
    const NOTE  = 'font-size:11px;color:var(--muted);margin:4px 0 0;line-height:1.4';
    const BOX   = 'border:1px solid var(--border);border-radius:8px;padding:10px;margin:8px 0 12px';
    const BADGE = 'display:inline-block;font-size:10px;padding:1px 6px;border-radius:8px;margin-left:6px;vertical-align:middle';

    function tplSelectHtml(list, currentIdNum) {
      const inList = list.some((t) => Number(t.id) === currentIdNum);
      const custom = (currentIdNum && !inList)
        ? `<option value="${currentIdNum}" selected>#${currentIdNum} (not in active list)</option>` : '';
      const opts = list.map((t) =>
        `<option value="${Number(t.id)}" ${Number(t.id) === currentIdNum ? 'selected' : ''}>` +
        `${esc(t.name)} (#${Number(t.id)}, ${esc(t.kind)})</option>`).join('');
      return `<select id="${prefix}-etpl-select" style="max-width:100%">` +
        `<option value="">— pick a template to load its fields —</option>${custom}${opts}</select>`;
    }

    function fieldRowsHtml(template) {
      const schema = Array.isArray(template.prefill_schema) ? template.prefill_schema : [];
      if (!schema.length) {
        return `<p style="${NOTE}">"${esc(template.name)}" declares no prefill fields — nothing to fill.</p>`;
      }
      const { values } = parseValues();
      const rows = schema.map((e) => {
        const v = values[e.key];
        const display = v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v));
        const req = e.required ? ' <span style="color:#ef4444">*</span>' : '';
        const typeBadge = `<span style="${BADGE};background:rgba(99,102,241,0.12);color:var(--muted)">${esc(e.type || 'text')}</span>`;
        const hint = e.resolver
          ? `<p style="${NOTE}">auto: <code>${esc(e.resolver)}</code> — leave blank to auto-fill; typing here overrides.</p>`
          : (e.default != null && e.default !== ''
            ? `<p style="${NOTE}">default: ${esc(String(e.default))} — leave blank to use it.</p>`
            : (e.required ? `<p style="${NOTE}">required — no resolver, no default: a value must come from here (placeholders ok).</p>` : ''));
        return `<div class="field" style="margin-bottom:8px">
          <label>${esc(e.label || e.key)}${req} <code style="font-size:10px;color:var(--muted)">${esc(e.key)}</code>${typeBadge}</label>
          <input class="${prefix}-etf" data-key="${esc(e.key)}" value="${esc(display)}" placeholder="${e.resolver ? '(auto)' : ''}">
          ${hint}
        </div>`;
      }).join('');
      return `<div style="font-size:11px;color:var(--muted);margin-bottom:8px">
          Template fields — entries write into <b>values</b> below (placeholders like
          <code>{{vars.fee}}</code> are fine; blank = auto-fill/default).
        </div>${rows}`;
    }

    async function render() {
      const p = panel();
      const idEl = tplInput();
      if (!p || !idEl) return;
      // Stale-timer guard, 6R-style: only meaningful for this function's form.
      const fnSel = el('fn') || document.getElementById(`${prefix}-fn`);
      if (fnSel && fnSel.value !== fnName) { p.style.display = 'none'; return; }

      p.style.display = '';
      const raw = (idEl.value || '').trim();

      if (PLACEHOLDER_RE.test(raw)) {
        p.innerHTML = `<div style="${BOX}"><p style="${NOTE};margin:0">` +
          `Dynamic template (<code>${esc(raw)}</code>) — fields can't be pre-loaded; ` +
          `edit <b>values</b> below as JSON.</p></div>`;
        return;
      }

      const list = await loadList();
      const idNum = raw !== '' && Number.isInteger(Number(raw)) ? Number(raw) : null;

      let body = tplSelectHtml(list, idNum || 0);
      if (idNum) {
        const t = await loadDetail(idNum);
        if (t == null) {
          body += `<p style="${NOTE}">Couldn't load template #${idNum} — network hiccup; edit values as JSON or retry.</p>`;
        } else if (t.notFound) {
          body += `<p style="${NOTE};color:#f59e0b">⚠ Template #${idNum} not found.</p>`;
        } else {
          if (t.active === false) body += `<p style="${NOTE};color:#f59e0b">⚠ "${esc(t.name)}" is deactivated — the send will refuse it.</p>`;
          body += fieldRowsHtml(t);
        }
      }
      p.innerHTML = `<div style="${BOX}">${body}</div>`;

      const sel = el('etpl-select');
      if (sel) {
        // Recreated by innerHTML each render, so a fresh listener each time is
        // correct (no accumulation — the old element is gone).
        sel.addEventListener('change', () => {
          const v = sel.value;
          idEl.value = v;
          idEl.dispatchEvent(new Event('input', { bubbles: true })); // debounced re-render below
        });
      }
    }

    // Delegated field-input handler — attached ONCE per panel element (the
    // panel div persists across renders while innerHTML is replaced, so
    // attaching inside render() would stack a duplicate per render).
    function wireDelegation() {
      const p = panel();
      if (!p || p.dataset.etplDelegated) return;
      p.dataset.etplDelegated = '1';
      p.addEventListener('input', (ev) => {
        if (!ev.target.classList || !ev.target.classList.contains(`${prefix}-etf`)) return;
        const raw = (tplInput()?.value || '').trim();
        const idNum = raw !== '' && Number.isInteger(Number(raw)) ? Number(raw) : null;
        const t = idNum ? state.detail.get(idNum) : null;
        if (t && !t.notFound) writeValuesFromFields(t.prefill_schema || []);
      });
    }

    function renderDebounced() {
      clearTimeout(state.timer);
      state.timer = setTimeout(render, 250);
    }

    // ── public: call after each editor render (setTimeout(…, 0)) ──
    function wire() {
      const idEl = tplInput();
      const ta = valuesTa();
      if (idEl && !idEl.dataset.etplWired) {
        idEl.dataset.etplWired = '1';
        idEl.addEventListener('input', renderDebounced);
      }
      if (ta && !ta.dataset.etplWired) {
        ta.dataset.etplWired = '1';
        ta.addEventListener('input', syncFieldsFromValues);
      }
      wireDelegation();
      render();
    }

    return { wire };
  };
})();