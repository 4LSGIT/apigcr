const E = (id) => document.getElementById(id);
const V = (id) => document.getElementById(id).value;
const S = (id) => document.getElementById(id).style;
const D = (id) => document.getElementById(id).style.display;
const U = (str) => encodeURIComponent( str.replace(/(["'`\\])/g, "\\\\$1").replace(/\n/g, "\\\\n"));
const X = (str) => str.replace(/(["'`\\])/g, "\\$1").replace(/\n/g, "\\n");
const P = window.parent;

/* localStorage-backed per-tab preference helpers.
   Composed storage key: `yc.${tab}.${key}` (e.g. yc.log.limit, yc.log.expand).
   Returns string or default; setTabPref coerces to String. Wrapped in
   try/catch because localStorage can throw under privacy mode / quota /
   disabled storage — silent degrade is fine for prefs. */
function getTabPref(tab, key, dflt) {
  try {
    const v = localStorage.getItem(`yc.${tab}.${key}`);
    return v == null ? dflt : v;
  } catch { return dflt; }
}
function setTabPref(tab, key, value) {
  try { localStorage.setItem(`yc.${tab}.${key}`, String(value)); }
  catch { /* storage disabled or full — degrade silently */ }
}

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

/* Pick the icon for a log row's Link cell.
   The literal log_link_type carries information the resolved entity does not
   (e.g. a phone-typed row that resolved to a contact still tells us the row
   arrived via phone-number matching, which is useful for debugging). So we
   honor the literal type whenever it exists.

   The fallback only kicks in for legacy NULL-typed rows (~161 rows currently)
   that predate the typed-enrichment migration. For those, there is no stored
   type, so we infer from the resolved entity (case_id / contact_id, hydrated
   server-side via JOIN on the legacy log_link column). */
function logEntryIcon(entry) {
  if (entry.log_link_type) {
    return logLinkTypeIcon(entry.log_link_type);
  }
  // NULL-typed legacy row — derive from resolved entity, mirroring the
  // link-rendering priority in tabLogGet.
  if (entry.case_id && isNaN(entry.log_link)) {
    return logLinkTypeIcon('case');
  }
  if (entry.contact_id) {
    return logLinkTypeIcon('contact');
  }
  return '';
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

/* Toggle the data-column collapse class on the log table and persist
   to yc.log.expand. Wired by renderLogFooter to the checkbox it injects. */
function toggleLogDataExpand() {
  const t = E('logTable');
  const cb = E('logExpandData');
  if (!t || !cb) return;
  t.classList.toggle('log-data-expanded', cb.checked);
  setTabPref('log', 'expand', cb.checked ? 'true' : 'false');
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

  // 3. Limit dropdown — pref-backed (yc.log.limit)
  const limitWrap = document.createElement('span');
  limitWrap.innerHTML = `<span class="sep">|</span> Limit
    <select style="width:auto" onchange="setTabPref('log','limit',this.value);limit=this.value;tabLogGet(0)">
      <option value="50"  ${limit == 50 ? "selected" : ""}>50</option>
      <option value="100" ${limit == 100 ? "selected" : ""}>100</option>
      <option value="200" ${limit == 200 ? "selected" : ""}>200</option>
      <option value="500" ${limit == 500 ? "selected" : ""}>500</option>
    </select>`;
  containerEl.appendChild(limitWrap);

  // 4. Expand toggle — CSS switch; pref-backed (yc.log.expand).
  // Read pref on every render and reflect on the table class so the source
  // of truth is the pref, not the in-DOM class. Toggle handler writes back.
  const tbl = E('logTable');
  const isExpanded = getTabPref('log', 'expand', 'false') === 'true';
  if (tbl) tbl.classList.toggle('log-data-expanded', isExpanded);
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

/* ──────────────────────────────────────────────────────────────────────────
   Phase 1 — Dialog rationalization primitives
   (ContactPicker, newContact, OrphanAdoptDialog) + shared helpers.

   These live here (not in a shell) so they're usable from the shell
   (a.html / b.html) and, in the future, from iframes. All network calls
   go through P.apiSend: in the shell P === window so P.apiSend ===
   window.apiSend; in an iframe P === parent and P.apiSend is the parent's
   auth wrapper (iframes also alias window.apiSend = P.apiSend).

   newContact opens the new contact/case file via the shell-global addFile
   on success. addFile is resolved defensively (shell global, else P.addFile)
   so a future iframe caller degrades to a toast rather than throwing.
   ────────────────────────────────────────────────────────────────────────── */

/* Format a 10-digit string as (###) ###-####. Non-10-digit input is
   returned as-is (after digit-stripping for display). Shared by the
   picker, the orphan dialog, and newContact's prefill. */
function fmtPhone(v) {
  const p = String(v == null ? '' : v).replace(/\D/g, '');
  return p.length === 10
    ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`
    : String(v == null ? '' : v);
}

/* Resolve the shell's addFile regardless of shell/iframe context.
   Returns a callable or null. */
function _resolveAddFile() {
  if (typeof addFile === 'function') return addFile;
  if (P && typeof P.addFile === 'function') return P.addFile;
  return null;
}

/* Inject styles for the ContactPicker dropdown once per document.
   Mirrors the injectLogHelpersStyles IIFE pattern above (guarded by id). */
(function injectContactPickerStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('contact-picker-styles')) return;
  const style = document.createElement('style');
  style.id = 'contact-picker-styles';
  style.textContent = `
    .cp-wrap { position: relative; }
    .cp-input { width: 100%; box-sizing: border-box; }
    /* In-flow dropdown (no absolute/fixed positioning). Rendering it in the
       normal document flow inside the SWAL popup guarantees result rows are
       clickable — absolute/fixed/body-mounted variants fought SWAL's overflow
       clipping and pointer trap. The dialog simply grows taller; the popup
       scrolls if needed. */
    .cp-dropdown {
      background: #ffffff;
      border: 1px solid #bbb;
      border-top: none;
      border-radius: 0 0 4px 4px;
      max-height: 16em;
      overflow-y: auto;
      box-shadow: 0 4px 10px rgba(0,0,0,0.12);
      text-align: left;
    }
    .cp-dropdown:empty { display: none; }
    .cp-row {
      padding: 0.4em 0.6em;
      cursor: pointer;
      background: #ffffff;
      border-bottom: 1px solid #eee;
    }
    .cp-row:last-child { border-bottom: none; }
    .cp-row:hover, .cp-row.cp-active { background: #eef4fb; }
    .cp-row .cp-name { font-weight: bold; }
    .cp-row .cp-sub { font-size: 0.85em; color: #777; }
    .cp-empty { padding: 0.4em 0.6em; color: #999; font-size: 0.9em; background: #fff; }

    /* ── Header / value ── */
    .oad-header { margin-bottom: 0.4em; }
    .oad-value { font-size: 1.15em; font-weight: bold; }
    .oad-earliest { font-size: 0.8em; color: #999; }

    /* ── De-emphasized top half (the start-date is rarely touched) ──
       Muted, smaller, set apart by a hairline below it so the eye drops
       past it to the search/create area, which is the primary action. */
    .oad-startdate-row {
      margin: 0.3em 0 0.7em;
      padding-bottom: 0.7em;
      border-bottom: 1px solid #eee;
      text-align: center;
      color: #888;
      font-size: 0.85em;
    }
    .oad-startdate-row input[type="date"] {
      font-size: 0.85em;
      padding: 0.15em 0.3em;
      color: #555;
    }

    /* ── Primary area: matches, create, search ── */
    .oad-section-label { font-weight: bold; font-size: 0.9em; margin: 0.6em 0 0.2em; text-align: left; }
    .oad-match {
      display: flex; align-items: center; justify-content: space-between;
      gap: 0.5em; padding: 0.4em 0.5em; border: 1px solid #e0e0e0;
      border-radius: 4px; margin-bottom: 0.3em; text-align: left;
    }
    .oad-match.oad-selected { border-color: #4a90e2; background: #eef4fb; }
    .oad-match .oad-match-name { font-weight: bold; }
    .oad-match .oad-match-src { font-size: 0.8em; color: #888; }

    /* Create-new button — bolder than a plain SWAL secondary so it reads as
       a real alternative to attaching. Outlined accent style. */
    .oad-create-btn {
      font-weight: bold;
      font-size: 0.95em;
      padding: 0.45em 1.1em;
      color: #2563eb;
      background: #fff;
      border: 2px solid #2563eb;
      border-radius: 5px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .oad-create-btn:hover { background: #2563eb; color: #fff; }

    /* Let the ContactPicker dropdown spill out of SWAL's html container
       instead of being clipped by its overflow:auto / max-height. The
       dropdown is position:absolute within .cp-wrap, so the ancestor must
       not clip. SWAL sets overflow:auto inline via its stylesheet, hence
       the override. */
    .swal2-html-container.oad-html { overflow: visible; }
    .oad-html .cp-dropdown { max-height: 12em; }
    /* ── CasePicker rows (Phase 3) ── */
    .cp-case-row .cp-case-num { font-weight: bold; font-size: 1.05em; }
    .cp-case-row .cp-sub { font-size: 0.85em; color: #777; }

    /* ── CaseAdoptDialog (Phase 4.1) ── */
    /* Same dropdown-spill fix as oad-html: let the CasePicker dropdown escape
       SWAL's overflow:auto html container instead of being clipped. */
    .swal2-html-container.cad-html { overflow: visible; }
    .cad-html .cp-dropdown { max-height: 12em; }
    .cad-fields { display: flex; gap: 0.6em; margin: 0.3em 0 0.6em; text-align: left; }
    .cad-field { flex: 1; }
    .cad-field label { display: block; font-size: 0.8em; color: #666; margin-bottom: 0.15em; }
    .cad-field input { width: 100%; box-sizing: border-box; }
    .cad-hint { font-size: 0.82em; color: #b58105; margin: 0 0 0.5em; text-align: left; }
    .cad-section-label { font-weight: bold; font-size: 0.9em; margin: 0.6em 0 0.2em; text-align: left; }
    .cad-preview {
      margin-top: 0.6em; padding: 0.45em 0.6em; text-align: left;
      font-size: 0.88em; color: #555; background: #f6f8fa;
      border: 1px solid #e3e7ea; border-radius: 4px; min-height: 1.2em;
    }
    .cad-preview:empty { display: none; }
    .cad-preview .cad-count { font-weight: bold; color: #1f2d3d; }
  `;
  document.head.appendChild(style);
})();


/* ──────────────────────────────────────────────────────────────────────────
   ContactPicker(hostEl, options)

   Mounts a typeahead <input> + results dropdown into hostEl.
   options = {
     onSelect(contactId, contactRow),   // called on row click
     placeholder = 'Search contacts…',
     initialQuery = ''
   }
   Returns { destroy(), getSelected() } where getSelected() returns the
   last-clicked { contact_id, contact } or null.

   Debounce 250ms. Cap 20. Empty input → empty dropdown (no fetch).
   Does NOT mutate the input value on select (caller owns focus/state).
   ────────────────────────────────────────────────────────────────────────── */
function ContactPicker(hostEl, options = {}) {
  const onSelect     = typeof options.onSelect === 'function' ? options.onSelect : () => {};
  const placeholder  = options.placeholder || 'Search contacts…';
  const initialQuery = options.initialQuery || '';

  hostEl.classList.add('cp-wrap');
  hostEl.innerHTML = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cp-input';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.value = initialQuery;

  // In-flow dropdown appended directly under the input inside hostEl. No
  // absolute/fixed positioning and no body/popup re-mounting: those variants
  // fought SWAL's overflow clipping and pointer trap, which broke row clicks.
  // An in-flow block inside the popup is always clickable; the dialog grows.
  const dropdown = document.createElement('div');
  dropdown.className = 'cp-dropdown';

  hostEl.appendChild(input);
  hostEl.appendChild(dropdown);

  let selected = null;   // { contact_id, contact }
  let timer = null;
  let seq = 0;           // request sequence guard against out-of-order responses
  let destroyed = false;

  function clearDropdown() { dropdown.innerHTML = ''; }

  function renderRows(rows) {
    clearDropdown();
    if (!rows || !rows.length) {
      const empty = document.createElement('div');
      empty.className = 'cp-empty';
      empty.textContent = 'No matches';
      dropdown.appendChild(empty);
      return;
    }
    rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'cp-row';

      const name = document.createElement('div');
      name.className = 'cp-name';
      name.textContent = r.contact_name || `Contact ${r.contact_id}`;
      row.appendChild(name);

      const phone = r.contact_phone ? fmtPhone(r.contact_phone) : '';
      const email = r.contact_email || '';
      if (phone || email) {
        const sub = document.createElement('div');
        sub.className = 'cp-sub';
        sub.textContent = phone && email ? `${phone} · ${email}` : (phone || email);
        row.appendChild(sub);
      }

      row.addEventListener('click', () => {
        selected = { contact_id: r.contact_id, contact: r };
        // Visual confirmation that the click registered: mark this row,
        // write the chosen name into the input, and collapse the list.
        dropdown.querySelectorAll('.cp-row').forEach((el) => el.classList.remove('cp-active'));
        row.classList.add('cp-active');
        input.value = r.contact_name || `Contact ${r.contact_id}`;
        clearDropdown();
        onSelect(r.contact_id, r);
      });
      dropdown.appendChild(row);
    });
  }

  async function runSearch(q) {
    const mySeq = ++seq;
    try {
      const data = await P.apiSend('/api/contacts', 'GET', { q, limit: 20 });
      if (destroyed || mySeq !== seq) return; // stale response
      renderRows((data && data.contacts) || []);
    } catch (err) {
      if (destroyed || mySeq !== seq) return;
      clearDropdown();
      const e = document.createElement('div');
      e.className = 'cp-empty';
      e.textContent = 'Search error';
      dropdown.appendChild(e);
    }
  }

  function onInput() {
    const q = input.value.trim();
    if (timer) clearTimeout(timer);
    if (!q) { seq++; clearDropdown(); return; }   // empty → no fetch, bump seq to void in-flight
    timer = setTimeout(() => runSearch(q), 250);
  }

  input.addEventListener('input', onInput);

  if (initialQuery.trim()) runSearch(initialQuery.trim());

  return {
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      input.removeEventListener('input', onInput);
      hostEl.innerHTML = '';   // dropdown is a child of hostEl — cleared here
    },
    getSelected() { return selected; },
    getQuery() { return input.value.trim(); },
    focus() { input.focus(); },
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   CasePicker(hostEl, options)

   Typeahead <input> + results dropdown for CASES. Sibling to ContactPicker
   (Phase 3). Deliberately a structural copy, NOT a shared abstraction — a
   _pickerBase earns itself at the third picker, not the second.

   options = {
     onSelect(caseId, caseRow),   // called on row click
     placeholder = 'Search cases…',
     initialQuery = ''
   }
   Returns { destroy(), getSelected(), getQuery(), focus() } where
   getSelected() returns the last-clicked { case_id, case } or null and
   getQuery() returns the trimmed current input value.

   Hits GET /api/cases/search?q=&limit=20 (the picker-shaped endpoint).
   Debounce 250ms. Cap 20. Empty input → empty dropdown (no fetch).
   Does NOT mutate the input value on select (caller owns focus/state).

   Row layout (3 lines, top-to-bottom):
     L1 (prominent): case_number_full || case_number || '(no case#)'
     L2 (muted):     case_id · case_type · case_stage
     L3 (muted):     primary_contact_name || '(no primary contact)'

   All text rendered via textContent (no innerHTML) → no escaping needed.
   ────────────────────────────────────────────────────────────────────────── */
function CasePicker(hostEl, options = {}) {
  const onSelect     = typeof options.onSelect === 'function' ? options.onSelect : () => {};
  const placeholder  = options.placeholder || 'Search cases…';
  const initialQuery = options.initialQuery || '';

  hostEl.classList.add('cp-wrap');
  hostEl.innerHTML = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cp-input';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.value = initialQuery;

  // In-flow dropdown (same rationale as ContactPicker — absolute/fixed/body
  // variants fight SWAL overflow clipping and break row clicks).
  const dropdown = document.createElement('div');
  dropdown.className = 'cp-dropdown';

  hostEl.appendChild(input);
  hostEl.appendChild(dropdown);

  let selected = null;   // { case_id, case }
  let timer = null;
  let seq = 0;           // request sequence guard against out-of-order responses
  let destroyed = false;

  function clearDropdown() { dropdown.innerHTML = ''; }

  function renderRows(rows) {
    clearDropdown();
    if (!rows || !rows.length) {
      const empty = document.createElement('div');
      empty.className = 'cp-empty';
      empty.textContent = 'No matches';
      dropdown.appendChild(empty);
      return;
    }
    rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'cp-row cp-case-row';

      // L1 — case number, prominent. Treat a case_number that merely echoes
      // the case_id as "no real number" (defensive; searchCases returns raw
      // columns so this normally won't happen, but the fallback chain stays
      // honest).
      const numRaw = r.case_number_full || r.case_number || '';
      const num = (numRaw && numRaw !== r.case_id) ? numRaw : '(no case#)';
      const line1 = document.createElement('div');
      line1.className = 'cp-case-num';
      line1.textContent = num;
      row.appendChild(line1);

      // L2 — case_id · case_type · case_stage
      const meta = [r.case_id, r.case_type, r.case_stage].filter(Boolean).join('  ·  ');
      const line2 = document.createElement('div');
      line2.className = 'cp-sub';
      line2.textContent = meta;
      row.appendChild(line2);

      // L3 — primary contact
      const line3 = document.createElement('div');
      line3.className = 'cp-sub';
      line3.textContent = r.primary_contact_name || '(no primary contact)';
      row.appendChild(line3);

      row.addEventListener('click', () => {
        selected = { case_id: r.case_id, case: r };
        dropdown.querySelectorAll('.cp-row').forEach((el) => el.classList.remove('cp-active'));
        row.classList.add('cp-active');
        // Do NOT mutate input.value — caller owns input state for cases.
        clearDropdown();
        onSelect(r.case_id, r);
      });
      dropdown.appendChild(row);
    });
  }

  async function runSearch(q) {
    const mySeq = ++seq;
    try {
      const data = await P.apiSend('/api/cases/search', 'GET', { q, limit: 20 });
      if (destroyed || mySeq !== seq) return; // stale response
      renderRows((data && data.cases) || []);
    } catch (err) {
      if (destroyed || mySeq !== seq) return;
      clearDropdown();
      const e = document.createElement('div');
      e.className = 'cp-empty';
      e.textContent = 'Search error';
      dropdown.appendChild(e);
    }
  }

  function onInput() {
    const q = input.value.trim();
    if (timer) clearTimeout(timer);
    if (!q) { seq++; clearDropdown(); return; }   // empty → no fetch, void in-flight
    timer = setTimeout(() => runSearch(q), 250);
  }

  input.addEventListener('input', onInput);

  if (initialQuery.trim()) runSearch(initialQuery.trim());

  return {
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      input.removeEventListener('input', onInput);
      hostEl.innerHTML = '';   // dropdown is a child of hostEl — cleared here
    },
    getSelected() { return selected; },
    getQuery() { return input.value.trim(); },
    focus() { input.focus(); },
  };
}


/* ──────────────────────────────────────────────────────────────────────────
   newContact(prefill = {}, onSuccess = null)

   Moved out of the shells (a.html / b.html) verbatim, then extended for
   the orphan-adopt create-new branch.

   prefill keys:
     name, phone, email                — pre-populate the matching field
     phone_start_date (YYYY-MM-DD)      — when present, render an editable
                                          date input next to phone, and send
                                          phone_start_date in the POST body
     email_start_date (YYYY-MM-DD)      — same for email
     force_create (boolean)             — force CREATE on the intake route
                                          (sends duplicate='duplicate' to skip
                                          find-or-create match). Used by the
                                          orphan-adopt create-new branch so a
                                          value that matches an existing contact
                                          still creates a fresh one.
     suppressOpen (boolean)             — when truthy, skip the addFile/openFile
                                          call so the user stays on the current
                                          surface (e.g. case2's create-new
                                          branch attaches the new contact to the
                                          case instead of opening its tab).
                                          onSuccess still fires.

   When *_start_date is absent the date inputs are NOT rendered — the header
   "+ New Client" UX is unchanged.

   onSuccess(data) fires after a successful create (client or case), AFTER the
   file is opened via addFile (unless suppressOpen). Receives the intake
   response object (data.id, data.name, data.status, …).
   ────────────────────────────────────────────────────────────────────────── */
function newContact(prefill = {}, onSuccess = null) {
  const hasPhoneStart = Object.prototype.hasOwnProperty.call(prefill, 'phone_start_date')
                        && prefill.phone_start_date != null;
  const hasEmailStart = Object.prototype.hasOwnProperty.call(prefill, 'email_start_date')
                        && prefill.email_start_date != null;
  const forceCreate = prefill.force_create === true;

  const phoneStartHtml = hasPhoneStart
    ? `<label class="input-label">Phone start date:</label>
       <input style="width:200px;" type="date" id="NCPhoneStart"><br>`
    : '';
  const emailStartHtml = hasEmailStart
    ? `<label class="input-label">Email start date:</label>
       <input style="width:200px;" type="date" id="NCEmailStart"><br>`
    : '';

  Swal.fire({
    title: "Add New Client:",
    html: `<label class="input-label">Name:</label>
         <input style="width:200px;" type="text" id="NCName" placeholder="Full Name"><br>
         <label class="input-label">Phone:</label>
         <input style="width:200px;" id="NCPhone" type="text" placeholder="(###) ###-####" title="Enter a valid phone number"><br>
         ${phoneStartHtml}
         <label class="input-label">Email:</label>
         <input style="width:200px;" id="NCEmail" type="text" placeholder="Email Address"><br>
         ${emailStartHtml}
         <label class="input-label">Set Appointment:</label>
         <input type="datetime-local" id="NCDate" style="width:200px;" disabled title="Coming soon"><br>
         <label class="sub-label" style="color:#999;">Temporarily disabled - coming soon.</label><br>
         <label class="input-label">Case Type:</label>
         <select id="NCType" style="width:200px;" onchange="E('NCOtherType').style.display = this.value === 'Other' ? '' : 'none';">
          <option selected value="">Select a case type</option>
          <option>Bankruptcy</option>
          <option>Other</option>
         </select>
         <input style="width:200px; display:none;" type="text" id="NCOtherType" placeholder="Enter case type"><br>
         <label class="sub-label">Optional, select type to create lead.</label><br>
         `,
    showCancelButton: true,
    showConfirmButton: true,
    cancelButtonText: "Cancel",
    confirmButtonText: "Add & Open Client",
    showCloseButton: true,
    showDenyButton: true,
    denyButtonText: "Add & Open Case",
    denyButtonColor: "#26abe2",
    showLoaderOnConfirm: true,
    showLoaderOnDeny: true,

    didOpen: () => {
      if (prefill.name) E("NCName").value = prefill.name;
      if (prefill.phone) {
        const p = String(prefill.phone).replace(/\D/g, "");
        E("NCPhone").value = p.length === 10
          ? `(${p.slice(0,3)}) ${p.slice(3,6)}-${p.slice(6)}`
          : prefill.phone;
      }
      if (prefill.email) E("NCEmail").value = prefill.email;
      if (hasPhoneStart && E("NCPhoneStart")) E("NCPhoneStart").value = prefill.phone_start_date;
      if (hasEmailStart && E("NCEmailStart")) E("NCEmailStart").value = prefill.email_start_date;
    },

    // ── ADD & OPEN CLIENT ──
    preConfirm: async () => {
      const name = E("NCName").value.trim();
      const phone = E("NCPhone").value.replace(/\D/g, "");
      const email = E("NCEmail").value.trim();
      const date = E("NCDate").value;
      const caseTypeRaw = E("NCType").value;
      const caseType = caseTypeRaw === "Other" ? E("NCOtherType").value.trim() : caseTypeRaw;

      // Relaxed validation: name + at least one of phone or email
      if (!name || (!E("NCPhone").value && !email)) {
        Swal.showValidationMessage("Name plus at least a phone or email is required");
        return false;
      }
      if (name.split(" ").length < 2) {
        Swal.showValidationMessage("Please fill in a valid full name");
        return false;
      }
      if (E("NCPhone").value && phone.length !== 10) {
        Swal.showValidationMessage("Please fill in a valid phone number");
        return false;
      }
      if (email && !/^\S+@\S+\.\S+$/.test(email)) {
        Swal.showValidationMessage("Please fill in a valid email address");
        return false;
      }
      if (caseTypeRaw === "Other" && !caseType) {
        Swal.showValidationMessage("Please enter a case type");
        return false;
      }

      try {
        const body = { name, phone, email };
        if (hasPhoneStart && E("NCPhoneStart") && E("NCPhoneStart").value) {
          body.phone_start_date = E("NCPhoneStart").value;
        }
        if (hasEmailStart && E("NCEmailStart") && E("NCEmailStart").value) {
          body.email_start_date = E("NCEmailStart").value;
        }
        if (forceCreate) body.duplicate = "duplicate";

        // 1. Create/update contact
        const contactResult = await P.apiSend("/api/intake/contact", "POST", body);

        // 2. If case type selected, create case too
        let caseResult = null;
        if (caseType) {
          caseResult = await P.apiSend("/api/intake/case", "POST", {
            contact_id: contactResult.id,
            case_type: caseType
          });
        }

        return { type: "client", data: contactResult };
      } catch (err) {
        Swal.showValidationMessage(err.message || "Failed to create client");
        return false;
      }
    },

    // ── ADD & OPEN CASE ──
    preDeny: async () => {
      const name = E("NCName").value.trim();
      const phone = E("NCPhone").value.replace(/\D/g, "");
      const email = E("NCEmail").value.trim();
      const date = E("NCDate").value;
      const caseTypeRaw = E("NCType").value;
      const caseType = caseTypeRaw === "Other" ? E("NCOtherType").value.trim() : caseTypeRaw;

      // Relaxed validation: name + at least one of phone or email + case type
      if (!name || (!E("NCPhone").value && !email)) {
        Swal.showValidationMessage("Name plus at least a phone or email is required");
        return false;
      }
      if (!caseType) {
        Swal.showValidationMessage("Please select a case type");
        return false;
      }
      if (caseTypeRaw === "Other" && !caseType) {
        Swal.showValidationMessage("Please enter a case type");
        return false;
      }
      if (name.split(" ").length < 2) {
        Swal.showValidationMessage("Please fill in a valid full name");
        return false;
      }
      if (E("NCPhone").value && phone.length !== 10) {
        Swal.showValidationMessage("Please fill in a valid phone number");
        return false;
      }
      if (email && !/^\S+@\S+\.\S+$/.test(email)) {
        Swal.showValidationMessage("Please fill in a valid email address");
        return false;
      }

      try {
        const body = { name, phone, email };
        if (hasPhoneStart && E("NCPhoneStart") && E("NCPhoneStart").value) {
          body.phone_start_date = E("NCPhoneStart").value;
        }
        if (hasEmailStart && E("NCEmailStart") && E("NCEmailStart").value) {
          body.email_start_date = E("NCEmailStart").value;
        }
        if (forceCreate) body.duplicate = "duplicate";

        // 1. Create/update contact
        const contactResult = await P.apiSend("/api/intake/contact", "POST", body);

        // 2. Create case
        const caseResult = await P.apiSend("/api/intake/case", "POST", {
          contact_id: contactResult.id,
          case_type: caseType
        });

        return { type: "case", data: caseResult, contactData: contactResult };
      } catch (err) {
        Swal.showValidationMessage(err.message || "Failed to create case");
        return false;
      }
    },

    allowOutsideClick: () => !Swal.isLoading()

  }).then((result) => {
    if (!result.isConfirmed && !result.isDenied) return; // cancelled
    if (!result.value) return;

    const { type, data } = result.value;

    Toast.fire({
      icon: data.status || "success",
      title: data.status === "success" ? "Success" : "Error",
      text: data.message
    });

    if (data.status === "success") {
      if (!prefill.suppressOpen) {
        const openFile = _resolveAddFile();
        if (type === "client") {
          if (openFile) openFile(data.name, "client", data.id);
        } else if (type === "case") {
          if (openFile) openFile(data.id, "case", data.id);
        }
      }
      if (typeof onSuccess === "function") onSuccess(data);
    }
  });
}


/* ──────────────────────────────────────────────────────────────────────────
   splitDocket(raw)  (Phase 4.1 — moved here as the single JS source)

   Parse a typed docket into { short, full, ok }.
     "25-44545-mar" → { short:'25-44545', full:'25-44545-mar', ok:true }
     "25-44545"     → { short:'25-44545', full:null,          ok:true }
     ""             → { short:'',         full:null,          ok:true }
     unparseable    → { short:<raw>,      full:null,          ok:false }

   Pure (no DOM/closure deps). The ##-#####-@@@ docket shape is
   BANKRUPTCY-SPECIFIC client-side convenience only — it is never a server
   gate. CaseAdoptDialog uses it as a pre-fill. (casedetails.html keeps its
   own copy by deliberate choice — accepted drift risk, see Phase 4.1 notes.)
   ────────────────────────────────────────────────────────────────────────── */
function splitDocket(raw) {
  const v = (raw || '').trim();
  if (!v) return { short: '', full: null, ok: true };
  const m = /^(\d{2}-\d{5})(-[A-Za-z]+)$/.exec(v);
  if (m) return { short: m[1], full: v, ok: true };
  if (/^\d{2}-\d{5}$/.test(v)) return { short: v, full: null, ok: true };
  // Doesn't match either shape — keep raw in the short column, leave full
  // null so we never persist a malformed "full". ok:false drives the hint.
  return { short: v, full: null, ok: false };
}


/* ──────────────────────────────────────────────────────────────────────────
   CaseAdoptDialog(value, onDone)  (Phase 4.1 — orphan-case adopt-existing)

   value = the orphan log_link_id (a docket string). Attaches that docket to
   an EXISTING case picked via CasePicker, by writing the case's
   case_number / case_number_full columns. Once written, listLog's JOIN
   (log_link = case_number OR = case_number_full) reattributes the orphan log
   rows automatically — no log-row UPDATE.

   Structural sibling of OrphanAdoptDialog. No force/overwrite path: collisions
   and "target already has a different docket" both hard-block (409 → stay open).

   Flow:
     1. splitDocket(value) → pre-fill two editable fields.
     2. SWAL: header + #cad-num / #cad-full inputs (+ soft hint if !ok),
        embedded CasePicker, impact-preview area, [Cancel] [Adopt].
        Adopt disabled until a case is picked.
     3. On pick / on field-edit (debounced) → fetch case-docket-preview with
        the CURRENT field values → render "N rows (DATE–DATE)".
     4. Adopt: PATCH /api/cases/:case_id/docket. 409 → validation message,
        stay open. Success → onDone({action:'adopted', case_id}).
   ────────────────────────────────────────────────────────────────────────── */
async function CaseAdoptDialog(value, onDone = null) {
  const parts = splitDocket(value);

  let selectedCase = null;   // { case_id, case }
  let picker = null;
  let previewTimer = null;
  let previewSeq = 0;        // guard against out-of-order preview responses

  const hintHtml = parts.ok
    ? ''
    : `<div class="cad-hint">Doesn't look like a standard docket — check the fields below.</div>`;

  // Build the params object for the preview/patch from the CURRENT field
  // values. Trim; omit empties entirely (URLSearchParams would otherwise
  // serialize null as the literal "null").
  function currentDocketVals() {
    const num  = (E('cad-num')  && E('cad-num').value  || '').trim();
    const full = (E('cad-full') && E('cad-full').value || '').trim();
    return { num, full };
  }

  function renderPreview(text, isCount) {
    const el = E('cad-preview');
    if (!el) return;
    el.textContent = '';
    if (!text) return;
    if (isCount) {
      // text is { count, range, caseLabel } — build with spans, no innerHTML.
      const strong = document.createElement('span');
      strong.className = 'cad-count';
      strong.textContent = String(text.count);
      el.appendChild(document.createTextNode('Adopting this will link '));
      el.appendChild(strong);
      el.appendChild(document.createTextNode(
        ` log row${text.count === 1 ? '' : 's'}` +
        (text.range ? ` (${text.range})` : '') +
        (text.caseLabel ? ` to ${text.caseLabel}.` : '.')
      ));
    } else {
      el.textContent = text;
    }
  }

  async function refreshPreview() {
    if (!selectedCase) return;
    const { num, full } = currentDocketVals();
    if (!num && !full) {
      renderPreview('Enter a case number to preview affected rows.', false);
      return;
    }
    const params = {};
    if (num)  params.case_number = num;
    if (full) params.case_number_full = full;

    const mySeq = ++previewSeq;
    try {
      const data = await P.apiSend('/api/log/case-docket-preview', 'GET', params);
      if (mySeq !== previewSeq) return; // stale
      const count = (data && Number(data.count)) || 0;
      const c = selectedCase.case || {};
      const caseLabel = c.case_number_full || c.case_number || c.case_id || 'the case';
      if (count === 0) {
        renderPreview('No log rows currently match these values (you can still adopt to pre-assign).', false);
      } else {
        const e = data.earliest_log_date, l = data.latest_log_date;
        const range = (e && l) ? (e === l ? e : `${e}–${l}`) : '';
        renderPreview({ count, range, caseLabel }, true);
      }
    } catch (err) {
      if (mySeq !== previewSeq) return;
      renderPreview('Preview unavailable.', false);
    }
  }

  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 300);
  }

  const result = await Swal.fire({
    title: 'Adopt case docket',
    html: `
      <div class="oad-header">
        <div class="oad-value">${escAttr(value)}</div>
      </div>
      ${hintHtml}
      <div class="cad-fields">
        <div class="cad-field">
          <label for="cad-num">Case number</label>
          <input type="text" id="cad-num" value="${escAttr(parts.short || '')}">
        </div>
        <div class="cad-field">
          <label for="cad-full">Case number (full)</label>
          <input type="text" id="cad-full" value="${escAttr(parts.full || '')}">
        </div>
      </div>
      <div class="cad-section-label">Find the case to attach this docket to</div>
      <div id="cad-picker-mount"></div>
      <div id="cad-preview" class="cad-preview"></div>
    `,
    showCancelButton: true,
    showConfirmButton: true,
    confirmButtonText: 'Adopt',
    cancelButtonText: 'Cancel',
    showCloseButton: true,
    customClass: { htmlContainer: 'cad-html' },
    allowOutsideClick: true,

    didOpen: () => {
      const confirmBtn = Swal.getConfirmButton();
      if (confirmBtn) confirmBtn.disabled = true;

      picker = CasePicker(E('cad-picker-mount'), {
        placeholder: 'Search cases…',
        onSelect: (cid, row) => {
          selectedCase = { case_id: cid, case: row };
          if (confirmBtn) confirmBtn.disabled = false;
          refreshPreview();
        },
      });

      // Recompute preview when either docket field is edited (debounced).
      ['cad-num', 'cad-full'].forEach((id) => {
        const inp = E(id);
        if (inp) inp.addEventListener('input', schedulePreview);
      });
    },

    preConfirm: async () => {
      const { num, full } = currentDocketVals();
      if (!num && !full) {
        Swal.showValidationMessage('Enter at least one of case number / full');
        return false;
      }
      if (!selectedCase) {
        Swal.showValidationMessage('Pick a case to attach this docket to.');
        return false;
      }
      const body = { case_number: num || null, case_number_full: full || null };
      try {
        await P.apiSend(`/api/cases/${encodeURIComponent(selectedCase.case_id)}/docket`, 'PATCH', body);
        return true;
      } catch (err) {
        // ApiError: err.status + err.body (parsed JSON). 409 → conflict/guard.
        const msg = (err && err.body && err.body.message) || err.message || 'Adopt failed';
        Swal.showValidationMessage(msg);
        return false;
      }
    },

    willClose: () => {
      if (previewTimer) clearTimeout(previewTimer);
      if (picker) picker.destroy();
    },
  });

  if (!result.isConfirmed) return;

  Toast.fire({ icon: 'success', title: 'Docket adopted' });
  if (typeof onDone === 'function') {
    onDone({ action: 'adopted', case_id: selectedCase.case_id });
  }
}


/* ──────────────────────────────────────────────────────────────────────────
   OrphanAdoptDialog(value, type, onDone)

   type ∈ {'phone','email'}. Replaces the orphan-row "+ Add as new contact"
   affordance with an attach-or-create dialog.

   Flow:
     1. Parallel: contact-lookup (suggested matches) + orphan-earliest
        (default start date).
     2. SWAL with: formatted value + "Earliest seen" line, editable start-date
        input, suggested-match attach buttons, an embedded ContactPicker,
        a "Create new contact" button, and [Cancel] [Attach].
     3. Attach: POST /api/contact-{phones|emails} (force in query). On 409
        conflict → confirm force-transfer → retry with ?force=true.
        On success → onDone({action:'attached', contact_id, force_used}).
     4. Create new: close, call newContact with the value + chosen start date
        prefilled (and duplicate='duplicate' so a matching value still creates).

   onDone is invoked ONLY on the attach success path. The create-new path
   delegates file-opening to newContact's own addFile call.
   ────────────────────────────────────────────────────────────────────────── */
async function OrphanAdoptDialog(value, type, onDone = null) {
  if (type !== 'phone' && type !== 'email') {
    console.error('OrphanAdoptDialog: invalid type', type);
    return;
  }
  const isPhone = type === 'phone';
  const displayValue = isPhone ? fmtPhone(value) : value;
  const lookupParam = isPhone ? { phone: value } : { email: value };

  // ── Fire the two reads in parallel (fail-soft on either) ──
  const [lookupRes, earliestRes] = await Promise.allSettled([
    P.apiSend('/api/contact-lookup', 'GET', lookupParam),
    P.apiSend('/api/log/orphan-earliest', 'GET', { type, value }),
  ]);

  const matches = (lookupRes.status === 'fulfilled' && lookupRes.value && Array.isArray(lookupRes.value.matches))
    ? lookupRes.value.matches
    : [];
  const earliest = (earliestRes.status === 'fulfilled' && earliestRes.value)
    ? (earliestRes.value.earliest_log_date || null)
    : null;

  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = earliest || today;

  // selected contact: { contact_id, contact_name } — set by suggested match
  // OR by the ContactPicker. The two are mutually exclusive.
  let selected = null;
  let picker = null;

  // Build suggested-matches HTML (only if ≥1)
  function matchSourceLabel(m) {
    const parts = [];
    if (m.matched_by_phone) parts.push(`phone: ${m.matched_by_phone.source}`);
    if (m.matched_by_email) parts.push(`email: ${m.matched_by_email.source}`);
    return parts.join(', ');
  }

  const matchesHtml = matches.length
    ? `<div class="oad-section-label">Suggested matches</div>` +
      matches.map((m) => `
        <div class="oad-match" data-cid="${m.contact_id}">
          <div>
            <div class="oad-match-name">${escAttr(m.contact_name || ('Contact ' + m.contact_id))}</div>
            <div class="oad-match-src">${escAttr(matchSourceLabel(m))}</div>
          </div>
          <button type="button" class="oad-attach-suggested" data-cid="${m.contact_id}"
                  data-cname="${escAttr(m.contact_name || ('Contact ' + m.contact_id))}">Attach</button>
        </div>`).join('')
    : '';

  const earliestHtml = earliest
    ? `<div class="oad-earliest">Earliest seen ${earliest}</div>`
    : '';

  // Capture the chosen start date at confirm time. Set by preConfirm so the
  // post-dialog attach flow can read it after the modal closes.
  let chosenStartDate = defaultStart;

  const result = await Swal.fire({
    title: isPhone ? 'Attach phone to contact' : 'Attach email to contact',
    html: `
      <div class="oad-header">
        <div class="oad-value">${escAttr(displayValue)}</div>
        ${earliestHtml}
      </div>
      <div class="oad-startdate-row">
        <label for="oadStartDate">Start date on contact:&nbsp;</label>
        <input type="date" id="oadStartDate" value="${defaultStart}">
      </div>
      <div id="oadMatches">${matchesHtml}</div>
      <div style="margin:0.5em 0;">
        <button type="button" id="oadCreateNew" class="oad-create-btn"><i class="fa-solid fa-user-plus"></i>&nbsp;Create new contact</button>
      </div>
      <div class="oad-section-label">Or search for another contact…</div>
      <div id="oadPicker"></div>
    `,
    showCancelButton: true,
    showConfirmButton: true,
    confirmButtonText: 'Attach',
    cancelButtonText: 'Cancel',
    showCloseButton: true,
    customClass: { htmlContainer: 'oad-html' },

    didOpen: () => {
      const confirmBtn = Swal.getConfirmButton();
      if (confirmBtn) confirmBtn.disabled = true;

      function markSelected(cid) {
        document.querySelectorAll('#oadMatches .oad-match').forEach((el) => {
          el.classList.toggle('oad-selected', String(el.getAttribute('data-cid')) === String(cid));
        });
      }

      function setSelected(cid, cname) {
        selected = { contact_id: cid, contact_name: cname };
        if (confirmBtn) confirmBtn.disabled = false;
      }

      // Suggested-match attach buttons → set selection (mutually exclusive
      // with picker). Clicking immediately also confirms for one-click attach.
      document.querySelectorAll('.oad-attach-suggested').forEach((btn) => {
        btn.addEventListener('click', () => {
          const cid = parseInt(btn.getAttribute('data-cid'), 10);
          const cname = btn.getAttribute('data-cname');
          setSelected(cid, cname);
          markSelected(cid);
          Swal.clickConfirm();
        });
      });

      // ContactPicker → selecting clears suggested-match highlight and enables Attach
      picker = ContactPicker(E('oadPicker'), {
        placeholder: 'Search contacts…',
        onSelect: (cid, row) => {
          setSelected(cid, row.contact_name);
          markSelected(null);
        },
      });

      // Create-new button: close this dialog, hand off to newContact.
      // force_create makes intake skip find-or-create so a value that
      // matches an existing contact still creates a fresh one. onSuccess
      // bubbles a 'created' event up through onDone so the caller (the
      // shell) can re-render the log tab at its current page.
      E('oadCreateNew').addEventListener('click', () => {
        const chosenDate = (E('oadStartDate') && E('oadStartDate').value) || defaultStart;
        if (picker) picker.destroy();
        Swal.close();
        const prefill = { force_create: true };
        if (isPhone) { prefill.phone = value; prefill.phone_start_date = chosenDate; }
        else         { prefill.email = value; prefill.email_start_date = chosenDate; }
        newContact(prefill, () => {
          if (typeof onDone === 'function') onDone({ action: 'created' });
        });
      });
    },

    // No network here — capturing the start date and validating a selection
    // exists. The attach POST runs AFTER this modal closes, so the 409
    // force-confirm doesn't nest a second SWAL inside this one (nesting
    // tears down the single shared modal instance).
    preConfirm: () => {
      if (!selected) {
        Swal.showValidationMessage('Pick a contact to attach to, or Create new.');
        return false;
      }
      chosenStartDate = (E('oadStartDate') && E('oadStartDate').value) || defaultStart;
      return true;
    },

    // Dropdown is in-flow inside the popup now, so clicking it is an inside
    // click — outside-click dismissal is safe to allow again.
    allowOutsideClick: true,
  });

  if (picker) picker.destroy();

  // Dialog dismissed (cancel / close / create-new path which called Swal.close()
  // without confirming) → nothing to attach.
  if (!result.isConfirmed || !selected) return;

  // ── Attach flow (sequential, non-nested SWALs) ──
  const endpoint = isPhone ? '/api/contact-phones' : '/api/contact-emails';
  const body = { contact_id: selected.contact_id, start_date: chosenStartDate };
  if (isPhone) body.phone = value; else body.email = value;

  let forceUsed = false;
  try {
    await P.apiSend(endpoint, 'POST', body);
  } catch (err) {
    // apiSend throws ApiError with err.status + err.body (parsed JSON).
    // The dedicated routes surface the service's conflict descriptor as
    // response.conflict on a 409.
    const conflict = (err && err.body && err.body.conflict) || null;
    const isConflict = (err && err.status === 409) || !!conflict;
    if (!isConflict) {
      Toast.fire({ icon: 'error', title: 'Attach failed', text: err.message || '' });
      return;
    }

    const donorName = (conflict && conflict.contact_name) ? conflict.contact_name : 'another contact';
    const recipientName = selected.contact_name || ('contact ' + selected.contact_id);
    const confirmForce = await Swal.fire({
      title: 'Already in use',
      html: `This ${isPhone ? 'phone' : 'email'} is active on <b>${escAttr(donorName)}</b>.<br>` +
            `Force-transfer it to <b>${escAttr(recipientName)}</b>? ` +
            `(Ends their ownership yesterday.)`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Force-transfer',
      cancelButtonText: 'Back',
    });
    if (!confirmForce.isConfirmed) {
      // User backed out of the transfer — re-open the picker dialog so they
      // can choose a different contact or Create new.
      return OrphanAdoptDialog(value, type, onDone);
    }
    try {
      await P.apiSend(endpoint + '?force=true', 'POST', body);
      forceUsed = true;
    } catch (err2) {
      Toast.fire({ icon: 'error', title: 'Force-transfer failed', text: err2.message || '' });
      return;
    }
  }

  Toast.fire({ icon: 'success', title: 'Attached' });
  if (typeof onDone === 'function') {
    onDone({ action: 'attached', contact_id: selected.contact_id, force_used: forceUsed });
  }
}