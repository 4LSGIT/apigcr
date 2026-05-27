const E = (id) => document.getElementById(id);
const V = (id) => document.getElementById(id).value;
const S = (id) => document.getElementById(id).style;
const D = (id) => document.getElementById(id).style.display;
const U = (str) => encodeURIComponent( str.replace(/(["'`\\])/g, "\\\\$1").replace(/\n/g, "\\\\n"));
const X = (str) => str.replace(/(["'`\\])/g, "\\$1").replace(/\n/g, "\\n");
const P = window.parent;

enc=o=>btoa(JSON.stringify(o)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''),
dec=s=>{try{return JSON.parse(atob(s.replace(/-/g,'+').replace(/_/g,'/')))}catch{return{}}}
/*
utility for making the url params stand out less
usage:
const url = `?v=${enc({ name: "bob" })}`;
const p = dec(new URLSearchParams(location.search).get('v'));
*/

function resizeTextarea(textarea) {
  textarea.style.height = "auto"; // Reset height
  textarea.style.height = Math.min(textarea.scrollHeight, 300) + "px"; // Adjust but don't exceed max
}

// Function to compare dates in EST with DST consideration
function whenDate(date) {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  date = new Date(date);
  if (now < date) {
    return "future";
  } else {
    return "past";
  }
}

window.Toast = Swal.mixin({
  toast: true,
  position: "top",
  showConfirmButton: true,
  timer: 3000,
  timerProgressBar: true,
  didOpen: (toast) => {
    toast.onmouseenter = Swal.stopTimer;
    toast.onmouseleave = Swal.resumeTimer;
  },
});

function copy(text) {
  navigator.clipboard.writeText(text);
  Toast.fire({ icon: "success", title: `"${text}" copied to clipboard!` });
}

function showProcessingSwal() {
  Swal.fire({
    title: "Processing...",
    html: '<div style="display: flex; align-items: center; justify-content: center; height: 150px; overflow: hidden; display: block"><i class="fa-solid fa-spinner fa-spin-pulse fa-6x"></i><br><p><div>please wait</p>',
    showConfirmButton: false,
    width: "250px",
  });
}

async function sendQuery(q) {
  try {
    const response = await fetch(
      `/db?username=${username}&password=${password}&query=${encodeURIComponent(
        q
      )}`
    );

    if (!response.ok) {
      throw new Error("Network response was not ok.");
    }

    const data = await response.json();
    console.log(data); // Handle the response data as needed
    return data;
  } catch (error) {
    console.error("Error:", error);
  }
}

function dateParts(dateString) {
  return dateString && !dateString.startsWith("0000-00-00")
    ? dateString.split("T")[0].split("-")
    : ["", "", ""];
}

function dateTimeParts(dateString) {
  dateString =
    dateString && !dateString.startsWith("0000-00-00")
      ? [
          ...dateString.split("T")[0].split("-"),
          ...dateString.split("T")[1].split(":").slice(0, 2),
        ]
      : ["", "", "", "", "", "", ""];
  dateString[5] = dateString[3] >= 12 ? "PM" : "AM";
  dateString[3] = dateString[3] > 12 ? dateString[3] - 12 : dateString[3];
  return dateString;
}

function sort(header, sort) {
  const parentDiv = header.parentNode.parentNode.parentNode.parentNode;
  const sortBy = parentDiv.querySelector('select[data-type="sortBy"]');
  const sortDi = parentDiv.querySelector('select[data-type="sortDi"]');
  const go = parentDiv.querySelector('button[data-type="goButton"]');
  const headers = parentDiv.querySelectorAll("th");
  sort = sort || header.innerText.replace(" ↑", "").replace(" ↓", "");
  if (sortBy.value !== sort) {
    sortBy.value = sort;
  } else {
    sortDi.value = sortDi.value === "ASC" ? "DESC" : "ASC";
  }
  headers.forEach(
    (h) => (h.innerText = h.innerText.replace(" ↑", "").replace(" ↓", ""))
  );
  header.innerText += sortDi.value === "ASC" ? " ↑" : " ↓";
  go.click();
}

function sortSelect(element) {
  const sortBy = element.parentNode.querySelector('select[data-type="sortBy"]');
  const sortDi = element.parentNode.querySelector('select[data-type="sortDi"]');
  const go = element.parentNode.querySelector('button[data-type="goButton"]');
  const table = element.parentNode.parentNode.querySelector("table");
  const headers = table.querySelectorAll("th");
  headers.forEach((head) => {
    let header = "";
    if (head.onclick) {
      header = head.getAttribute("onclick").split("'")[1];
    }
    let text = head.innerText.replace(" ↑", "").replace(" ↓", "");
    if (sortBy.value === header) {
      head.innerText = `${text} ${sortDi.value === "ASC" ? " ↑" : " ↓"}`;
    } else {
      head.innerText = text;
    }
  });
  go.click();
}

/* ──────────────────────────────────────────────────────────────────────────
   Log tab shared helpers (Slice B.3 + B.4)
   Used by a.html, b.html, contact2.html, case2.html.

   Calling contract — each caller defines:
     • tabLogGet(offset)     — refreshes the log table at the given offset
     • getLogFilterParams()  — returns the *current* filter param object,
                               WITHOUT limit/offset (those are added per call)
     • global `limit`        — current page size

   Iframe pages use P.apiSend (parent's auth wrapper). Top-level pages have
   P === window, so P.apiSend === window.apiSend.
   ────────────────────────────────────────────────────────────────────────── */

/* Inject styles once per document (top-level + each iframe gets its own copy). */
(function injectLogHelpersStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('log-helpers-styles')) return;
  const style = document.createElement('style');
  style.id = 'log-helpers-styles';
  style.textContent = `
    .logTable .log-data-cell {
      max-width: 40em;
      min-width: 15em;
    }
    .logTable .log-data-cell .log-data-row {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .logTable.log-data-expanded .log-data-cell .log-data-row {
      white-space: normal;
      overflow: visible;
      text-overflow: clip;
    }
    #logTableFoot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.6em;
      padding: 0.6em 0;
      font-size: 0.95em;
    }
    #logTableFoot .sep {
      color: #ccc;
      margin: 0 0.15em;
      user-select: none;
    }
    #logTableFoot .log-pagination {
      display: inline-flex;
      align-items: center;
      gap: 0.35em;
    }
    #logTableFoot .log-pagination a {
      text-decoration: none;
      padding: 0.15em 0.5em;
      border-radius: 3px;
    }
    #logTableFoot .log-pagination a:hover {
      background: #eef;
      text-decoration: underline;
    }
    #logTableFoot .log-pagination strong {
      padding: 0.15em 0.5em;
      background: #f0f0f0;
      border-radius: 3px;
      font-weight: bold;
    }
    #logTableFoot .log-pagination-ellipsis {
      color: #888;
      padding: 0 0.1em;
    }
    #logTableFoot .logPageInput {
      width: 4.5em;
      text-align: center;
      font-weight: bold;
      padding: 0.15em 0.3em;
      border: 1px solid #bbb;
      border-radius: 3px;
      -moz-appearance: textfield;
    }
    #logTableFoot .logPageInput::-webkit-outer-spin-button,
    #logTableFoot .logPageInput::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    /* Toggle label (wraps switch + text) */
    #logTableFoot .log-expand-toggle {
      cursor: pointer;
      user-select: none;
      display: inline-flex;
      align-items: center;
      gap: 0.5em;
    }
    /* CSS-only toggle switch — pure visual, replaces a plain checkbox */
    .log-switch {
      position: relative;
      display: inline-block;
      width: 32px;
      height: 18px;
      vertical-align: middle;
      flex: 0 0 auto;
    }
    .log-switch input {
      opacity: 0;
      width: 0;
      height: 0;
      margin: 0;
      position: absolute;
    }
    .log-switch-slider {
      position: absolute;
      cursor: pointer;
      inset: 0;
      background-color: #ccc;
      transition: background-color 0.15s;
      border-radius: 18px;
    }
    .log-switch-slider::before {
      position: absolute;
      content: "";
      height: 14px;
      width: 14px;
      left: 2px;
      bottom: 2px;
      background-color: white;
      transition: transform 0.15s;
      border-radius: 50%;
      box-shadow: 0 1px 2px rgba(0,0,0,0.2);
    }
    .log-switch input:checked + .log-switch-slider {
      background-color: #4a90e2;
    }
    .log-switch input:checked + .log-switch-slider::before {
      transform: translateX(14px);
    }
    .log-switch input:focus-visible + .log-switch-slider {
      box-shadow: 0 0 0 2px #a5c7ee;
    }
    #logTableFoot button {
      padding: 0.2em 0.7em;
    }

    /* Scoped reset for the export dialog — neutralises any global
       \`input { width: 200px; ... }\` rule that would otherwise stretch
       the radio buttons and number inputs. Specificity (class + tag) beats
       the bare \`input\` selector, so no !important needed. */
    .export-csv-dialog input[type="radio"] {
      width: auto;
      height: auto;
      padding: 0;
      margin: 0;
      flex: 0 0 auto;
      vertical-align: middle;
    }
    .export-csv-dialog input[type="number"] {
      width: 6em;
      height: auto;
      padding: 0.2em 0.4em;
      margin: 0;
      flex: 0 0 auto;
    }
    .export-csv-dialog label {
      cursor: pointer;
    }
    .export-csv-dialog .hint {
      color: #888;
      font-size: 0.9em;
    }
  `;
  document.head.appendChild(style);
})();

/* Log link-type → icon mapping. NULL/unknown → no icon (alignment preserved). */
const LOG_LINK_TYPE_ICONS = {
  contact: ['fa-user',                 'Contact'],
  case:    ['fa-folder',               'Case'],
  phone:   ['fa-phone',                'Phone'],
  email:   ['fa-envelope',             'Email'],
  appt:    ['fa-calendar',             'Appointment'],
  bill:    ['fa-file-invoice-dollar',  'Bill'],
  task:    ['fa-square-check',         'Task'],
};

function logLinkTypeIcon(linkType) {
  const m = LOG_LINK_TYPE_ICONS[linkType];
  return m
    ? `<i class="fa-solid ${m[0]}" title="${m[1]}" style="color:#888;margin-right:4px;font-size:0.85em"></i>`
    : '';
}

/* Whether a log_extra payload has anything worth inspecting.
   mysql2 returns JSON columns as parsed objects; pre-Slice4 rows may be strings. */
function logHasExtras(extra) {
  if (extra == null) return false;
  if (typeof extra === 'object') return Object.keys(extra).length > 0;
  const s = String(extra).trim();
  return s !== '' && s !== '{}';
}

function logExtrasIcon(entry) {
  if (!logHasExtras(entry.log_extra)) return '';
  return ` <i class="fa-solid fa-circle-info" title="View details"
              style="color:#888;cursor:pointer;font-size:0.85em"
              onclick="showLogDetails(${entry.log_id});return false"></i>`;
}

/* Escape a string for safe insertion inside an HTML attribute value
   (quoted with double quotes). Also escapes < to avoid breaking out of
   attribute context if the browser tolerates malformed input. */
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/* Build the Data cell HTML — each key gets its own .log-data-row line,
   with a title attribute carrying the full value for hover-reveal. */
function buildLogDataCell(entry) {
  let inner;
  try {
    const raw = (entry.log_data || '').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    const jsonData = JSON.parse(raw);
    inner = Object.keys(jsonData).map(key => {
      let v = jsonData[key];
      try { v = decodeURIComponent(String(v)); } catch { /* leave as-is */ }
      const titleSafe = escAttr(v);
      return `<div class="log-data-row" title="${titleSafe}"><b>${key}:</b> ${v}</div>`;
    }).join('');
  } catch {
    const raw = entry.log_data || '';
    inner = `<div class="log-data-row" title="${escAttr(raw)}">${raw}</div>`;
  }
  return `<div class="log-data-cell">${inner}</div>`;
}

/* SWAL inspector — fetches full row via GET /api/log/:id and renders a
   pretty-printed payload. Tolerates missing fields (e.g. if the GET-one
   SELECT is thinner than expected) by showing null for anything absent. */
async function showLogDetails(logId) {
  try {
    const r = await P.apiSend('/api/log/' + encodeURIComponent(logId), 'GET');
    const e = (r && (r.entry || r.data)) || r || {};

    let decodedData;
    try {
      const raw = (e.log_data || '').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      const parsed = JSON.parse(raw);
      decodedData = Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => {
          try { return [k, decodeURIComponent(String(v))]; }
          catch { return [k, v]; }
        })
      );
    } catch {
      decodedData = e.log_data || null;
    }

    const payload = {
      id:        e.log_id,
      type:      e.log_type,
      date:      e.log_date || e.formatted_date || null,
      direction: e.log_direction || null,
      from:      e.log_from || null,
      to:        e.log_to || null,
      subject:   e.log_subject || null,
      by:        e.by_name || e.log_by || null,
      link: {
        type:   e.log_link_type || null,
        id:     e.log_link_id || null,
        legacy: e.log_link || null,
      },
      message: e.log_message || null,
      data:    decodedData,
      extra:   e.log_extra || null,
    };

    const escaped = JSON.stringify(payload, null, 2)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    Swal.fire({
      title: `Log #${e.log_id || logId}`,
      html: `<pre style="text-align:left;max-height:60vh;overflow:auto;
                          font-size:0.85em;white-space:pre-wrap;
                          word-break:break-word;margin:0">${escaped}</pre>`,
      width: 800,
      confirmButtonText: 'Close',
    });
  } catch (err) {
    Toast.fire({
      icon: 'error',
      title: 'Failed to load log details',
      text: err && err.message ? err.message : String(err),
    });
  }
}

/* Ellipsis-windowed log pagination — NO « » arrows (per spec).
     • Compact mode (totalPages ≤ 7): all pages, bold current, no input.
     • Ellipsis mode (>7):            first 2 + last 2 + window ±2 around
                                       current; current is <input>; gaps
                                       between groups shown as `…`.
   Click on any number → jumpFn(page). Enter/blur in input → jumpFn(page),
   clamped to [1, totalPages]. */
function renderLogPagination(containerEl, total, limit, offset, jumpFn) {
  containerEl.innerHTML = '';
  if (!total || total < 0) total = 0;
  if (!limit || limit < 1) limit = 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const current = Math.min(totalPages, Math.max(1, Math.floor(offset / limit) + 1));

  const parts = [];

  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) {
      parts.push(i === current
        ? `<strong>${i}</strong>`
        : `<a href="#" data-page="${i}">${i}</a>`);
    }
  } else {
    const pages = new Set([1, 2, totalPages - 1, totalPages]);
    for (let p = current - 2; p <= current + 2; p++) {
      if (p >= 1 && p <= totalPages) pages.add(p);
    }
    const sorted = [...pages].sort((a, b) => a - b);
    let prev = 0;
    for (const p of sorted) {
      if (prev && p > prev + 1) parts.push(`<span class="log-pagination-ellipsis">…</span>`);
      if (p === current) {
        parts.push(
          `<input type="number" min="1" max="${totalPages}" value="${current}"
                  class="logPageInput" aria-label="Jump to page">`
        );
      } else {
        parts.push(`<a href="#" data-page="${p}">${p}</a>`);
      }
      prev = p;
    }
  }

  containerEl.innerHTML = parts.join(' ');

  containerEl.querySelectorAll('a[data-page]').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const p = parseInt(a.getAttribute('data-page'), 10);
      if (!isNaN(p)) jumpFn(p);
    });
  });

  const input = containerEl.querySelector('.logPageInput');
  if (input) {
    const submit = () => {
      let p = parseInt(input.value, 10);
      if (isNaN(p)) { input.value = current; return; }
      p = Math.max(1, Math.min(totalPages, p));
      if (p !== current) jumpFn(p);
      else input.value = current;
    };
    input.addEventListener('keypress', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });
    input.addEventListener('blur', submit);
    input.addEventListener('focus', () => input.select());
  }
}

/* Toggle the data-column collapse class on the log table. Wired by
   renderLogFooter to the checkbox it injects. */
function toggleLogDataExpand() {
  const t = E('logTable');
  const cb = E('logExpandData');
  if (!t || !cb) return;
  t.classList.toggle('log-data-expanded', cb.checked);
}

/* Render the full log-table footer: pagination | meta | limit | toggle | print + export.
   `exportFn` is optional — omit to hide the Export button. */
function renderLogFooter(containerEl, data, limit, offset, jumpFn, exportFn) {
  containerEl.innerHTML = '';

  const total = data.total || 0;
  const shownStart = total === 0 ? 0 : offset + 1;
  const shownEnd = Math.min(total, offset + ((data.entries && data.entries.length) || 0));

  // 1. Pagination
  const pagWrap = document.createElement('span');
  pagWrap.className = 'log-pagination';
  containerEl.appendChild(pagWrap);
  renderLogPagination(pagWrap, total, limit, offset, jumpFn);

  // 2. Showing N-M of T
  const meta = document.createElement('span');
  meta.innerHTML = `<span class="sep">|</span> Showing ${shownStart}–${shownEnd} of ${total}`;
  containerEl.appendChild(meta);

  // 3. Limit dropdown
  const limitWrap = document.createElement('span');
  limitWrap.innerHTML = `<span class="sep">|</span> Limit
    <select style="width:auto" onchange="limit=this.value;tabLogGet(0)">
      <option value="50"  ${limit == 50 ? "selected" : ""}>50</option>
      <option value="100" ${limit == 100 ? "selected" : ""}>100</option>
      <option value="200" ${limit == 200 ? "selected" : ""}>200</option>
      <option value="500" ${limit == 500 ? "selected" : ""}>500</option>
    </select>`;
  containerEl.appendChild(limitWrap);

  // 4. Expand toggle — CSS switch, preserves state across re-renders
  const tbl = E('logTable');
  const isExpanded = tbl && tbl.classList.contains('log-data-expanded');
  const toggleWrap = document.createElement('span');
  toggleWrap.innerHTML = `<span class="sep">|</span>
    <label class="log-expand-toggle" title="Expand data rows in the log table">
      <span class="log-switch">
        <input type="checkbox" id="logExpandData" ${isExpanded ? 'checked' : ''}>
        <span class="log-switch-slider"></span>
      </span>
      <span>Expand rows</span>
    </label>`;
  containerEl.appendChild(toggleWrap);
  const cb = containerEl.querySelector('#logExpandData');
  if (cb) cb.addEventListener('change', toggleLogDataExpand);

  // 5. Print + Export buttons
  const btnWrap = document.createElement('span');
  btnWrap.innerHTML = `<span class="sep">|</span>
    <button type="button" class="log-print-btn">Print</button>
    ${exportFn ? '<button type="button" class="log-export-btn">Export</button>' : ''}`;
  containerEl.appendChild(btnWrap);
  containerEl.querySelector('.log-print-btn')
    .addEventListener('click', () => window.print());
  if (exportFn) {
    containerEl.querySelector('.log-export-btn').addEventListener('click', exportFn);
  }
}

/* CSV export — three-step flow:
     1. Probe (limit=1) to learn the total under current filters.
     2. Ask the user via Swal: export a from–to range, or export all (with a
        soft warning when total > MAX_EXPORT_ROWS).
     3. Fetch the chosen range and download.
   `getFilterParams()` returns the current filter set WITHOUT limit/offset. */
const MAX_EXPORT_ROWS = 10000;

async function exportLogCsv(getFilterParams, filenamePrefix) {
  filenamePrefix = filenamePrefix || 'yisracase-log';

  // ── Step 1: probe for total
  showProcessingSwal();
  let total;
  try {
    const probe = await P.apiSend('/api/log', 'GET',
      { ...getFilterParams(), limit: 1, offset: 0 });
    total = (probe && probe.total) || 0;
    Swal.close();
  } catch (err) {
    Swal.close();
    Toast.fire({
      icon: 'error',
      title: 'Export check failed',
      text: err && err.message ? err.message : String(err),
    });
    return;
  }

  if (total === 0) {
    Toast.fire({ icon: 'info', title: 'No rows match the current filters' });
    return;
  }

  // ── Step 2: ask user — range vs all
  const defaultTo = Math.min(total, MAX_EXPORT_ROWS);
  const showLargeWarning = total > MAX_EXPORT_ROWS;
  const totalStr = total.toLocaleString();

  const result = await Swal.fire({
    title: 'Export to CSV',
    html: `
      <div class="export-csv-dialog" style="text-align:left;font-size:0.95em">
        <p style="margin:0 0 0.3em">Found <b>${totalStr}</b> matching rows.</p>
        <p class="hint" style="margin:0 0 1em">Recommended max per export: ${MAX_EXPORT_ROWS.toLocaleString()} rows.</p>
        <label style="display:flex;align-items:center;flex-wrap:wrap;gap:0.4em;margin-bottom:0.7em">
          <input type="radio" name="exp_mode" value="range" checked>
          <span>Export rows</span>
          <input type="number" id="exp_from" min="1" max="${total}" value="1"
                 onfocus="this.parentNode.querySelector('input[value=&quot;range&quot;]').checked=true;this.select()">
          <span>to</span>
          <input type="number" id="exp_to" min="1" max="${total}" value="${defaultTo}"
                 onfocus="this.parentNode.querySelector('input[value=&quot;range&quot;]').checked=true;this.select()">
          <span class="hint">(of ${totalStr})</span>
        </label>
        <label style="display:flex;align-items:center;gap:0.5em">
          <input type="radio" name="exp_mode" value="all">
          <span>Export all ${totalStr} rows${
            showLargeWarning
              ? '<span style="color:#c00;font-size:0.88em;margin-left:0.4em">— large, may be slow or fail</span>'
              : ''
          }</span>
        </label>
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: 'Export',
    cancelButtonText: 'Cancel',
    focusConfirm: false,
    preConfirm: () => {
      const modeEl = document.querySelector('input[name="exp_mode"]:checked');
      if (!modeEl) { Swal.showValidationMessage('Choose an option'); return false; }
      if (modeEl.value === 'all') return { from: 1, to: total };
      const from = parseInt(document.getElementById('exp_from').value, 10);
      const to   = parseInt(document.getElementById('exp_to').value, 10);
      if (isNaN(from) || isNaN(to)) {
        Swal.showValidationMessage('Enter numbers for both From and To');
        return false;
      }
      if (from < 1) {
        Swal.showValidationMessage('From must be at least 1');
        return false;
      }
      if (to > total) {
        Swal.showValidationMessage(`To must be at most ${total}`);
        return false;
      }
      if (from > to) {
        Swal.showValidationMessage('From must be ≤ To');
        return false;
      }
      return { from, to };
    },
  });

  if (!result.isConfirmed) return;
  const { from, to } = result.value;
  const limit  = to - from + 1;
  const offset = from - 1;

  // ── Step 3: fetch range and download
  showProcessingSwal();
  try {
    const data = await P.apiSend('/api/log', 'GET',
      { ...getFilterParams(), limit, offset });
    Swal.close();

    const entries = (data && data.entries) || [];
    if (entries.length === 0) {
      Toast.fire({ icon: 'info', title: 'No rows returned' });
      return;
    }

    const csv = buildLogCsv(entries);
    const ts = new Date().toISOString().slice(0, 10);
    const rangeSuffix = (from === 1 && to === total) ? '' : `-${from}-${to}`;
    downloadFile(csv, `${filenamePrefix}${rangeSuffix}-${ts}.csv`, 'text/csv;charset=utf-8;');
    Toast.fire({ icon: 'success', title: `Exported ${entries.length} rows` });
  } catch (err) {
    Swal.close();
    Toast.fire({
      icon: 'error',
      title: 'Export failed',
      text: err && err.message ? err.message : String(err),
    });
  }
}

/* Columns exported. Adjust this list if you want different defaults. */
const LOG_CSV_COLUMNS = [
  { key: 'log_id',         label: 'Log ID' },
  { key: 'formatted_date', label: 'Date/Time' },
  { key: 'log_date',       label: 'Date (ISO)' },
  { key: 'log_type',       label: 'Type' },
  { key: 'log_direction',  label: 'Direction' },
  { key: 'log_link_type',  label: 'Link Type' },
  { key: 'log_link_id',    label: 'Link ID' },
  { key: 'log_link',       label: 'Link (legacy)' },
  { key: 'contact_id',     label: 'Contact ID' },
  { key: 'contact_name',   label: 'Contact Name' },
  { key: 'case_id',        label: 'Case ID' },
  { key: 'case_number',    label: 'Case Number' },
  { key: 'log_from',       label: 'From' },
  { key: 'log_to',         label: 'To' },
  { key: 'log_subject',    label: 'Subject' },
  { key: 'log_message',    label: 'Message' },
  { key: 'log_data',       label: 'Data' },
  { key: 'log_extra',      label: 'Extra' },
  { key: 'by_name',        label: 'By' },
];

function csvEscape(v) {
  if (v == null) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildLogCsv(rows) {
  const header = LOG_CSV_COLUMNS.map(c => csvEscape(c.label)).join(',');
  const lines = rows.map(r =>
    LOG_CSV_COLUMNS.map(c => csvEscape(r[c.key])).join(',')
  );
  return '\ufeff' + header + '\r\n' + lines.join('\r\n');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}