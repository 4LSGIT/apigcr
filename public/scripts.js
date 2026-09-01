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

/* ──────────────────────────────────────────────────────────────────────────
   applyFeSetting — keep the LIVE firm-data settings map current.

   The shell fetches /api/firm-data once at boot; every frame then reads
   firmData.settings for its dropdown vocabularies (case types, event types,
   lead sources, trustees). Editing one of those rows in settings.html used to
   leave every already-open frame reading a stale map until reload. The sync
   bus now announces `setting:<key>` with the raw stored string (see
   public/js/yc-sync.js), and this is the ONE function that turns that string
   back into what /api/firm-data would have shipped.

   It mirrors routes/api.firmData.js EXACTLY — same prefix strip, same
   JSON.parse-with-raw-string-fallback, same "only fe-* rows are frontend
   settings" rule. If that route's semantics ever change, change both.

   WHY EVERY FRAME CALLS THIS, not just the shell: BroadcastChannel delivery
   order across browsing contexts is unspecified, so in a SECOND browser tab
   case.html's handler may run before that tab's shell handler. Every handler
   doing the same idempotent write from the same payload makes ordering
   irrelevant. (In the writing tab the shell's local dispatch inside emit() is
   synchronous and runs first anyway.) In a frame that aliases the shell's
   object — case.html does `window.firmData = P.firmData` — the two writes
   land on the same object, so "idempotent" is structural, not just careful.

   §3.6: this MUTATES STATE AND RETURNS. It must never emit.

   @param   {string} key    the full app_settings key, e.g. 'fe-case_types'
   @param   {*}      value  the raw stored value (a string in practice)
   @returns {boolean} true if the live map was written, false otherwise
   ────────────────────────────────────────────────────────────────────────── */
function applyFeSetting(key, value) {
  if (typeof key !== 'string' || key.indexOf('fe-') !== 0) return false;
  const k = key.slice(3);                       // drop 'fe-' — same as the route

  let parsed = value;
  if (typeof parsed === 'string') {
    // A row can ship an array/object/number/bool; plain scalars aren't quoted,
    // so a parse failure is normal and means "it was already a string".
    try { parsed = JSON.parse(parsed); } catch { /* keep raw string */ }
  }

  let firm = (typeof window !== 'undefined' && window.firmData) ? window.firmData : null;
  if (!firm) {
    // Frames that never aliased it (pipelineBoard, tasks, the widgets) read
    // through to the shell. Guarded: window.top throws cross-origin.
    try { firm = (window.top && window.top.firmData) || null; } catch { firm = null; }
  }
  if (!firm || !firm.settings) return false;

  firm.settings[k] = parsed;
  return true;
}

/* ──────────────────────────────────────────────────────────────────────────
   Event types — single source of truth.

   getEventTypeOptions() is the ONE place the create/edit dialog and the
   shell's Events-tab filter both read from, so they can never drift apart.

   Source: firmData.settings.event_types (shipped down by /api/firm-data from
   the app_settings row 'fe-event_types'). Tolerates either a JSON array
   (preferred) or a CSV string. Empty/missing → the built-in default below, so
   the UI always has a list even before the setting is configured.
   ────────────────────────────────────────────────────────────────────────── */
const EVENT_TYPE_OPTIONS_DEFAULT = [
  'Confirmation Hearing', 'Docs Deadline', 'Deadline',
  'Court Date', 'Hearing', 'Internal',
];
function getEventTypeOptions() {
  const firm = (typeof window !== 'undefined' && window.firmData)
    ? window.firmData
    : ((typeof P !== 'undefined' && P && P.firmData) || {});
  const raw = firm && firm.settings && firm.settings.event_types;
  let list = [];
  if (Array.isArray(raw)) {
    list = raw.map(s => String(s).trim()).filter(Boolean);
  } else if (typeof raw === 'string') {
    list = raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  return list.length ? list : EVENT_TYPE_OPTIONS_DEFAULT.slice();
}

/* ──────────────────────────────────────────────────────────────────────────
   Case types — single source of truth (2026-06 type/subtype split).

   cases.case_type is a CATEGORY ("Bankruptcy", "Appeal", …) and
   cases.case_subtype the refinement ("Chapter 7", …). The valid combinations
   live in the app_settings row 'fe-case_types' and ship down exactly like
   'fe-event_types': /api/firm-data JSON-parses every fe-* row into
   firmData.settings, so the map is at firmData.settings.case_types — a plain
   object of type → array-of-subtypes. Missing/malformed → the default below.

   Values stay OPAQUE free text: nothing here validates shape, and stored
   values absent from the map must still render (and appear as a
   selected-but-unlisted option when editing).
   ────────────────────────────────────────────────────────────────────────── */
const CASE_TYPE_MAP_DEFAULT = {
  'Bankruptcy': ['Chapter 7', 'Chapter 13'],
  'Adversary Proceeding': ['Bankruptcy', 'Criminal'],
  'Appeal': ['Bankruptcy', 'Litigation'],
  'Litigation': [],
  'Other': [],
};
function getCaseTypeMap() {
  const firm = (typeof window !== 'undefined' && window.firmData)
    ? window.firmData
    : ((typeof P !== 'undefined' && P && P.firmData) || {});
  const raw = firm && firm.settings && firm.settings.case_types;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const map = {};
    let any = false;
    for (const [t, subs] of Object.entries(raw)) {
      const key = String(t).trim();
      if (!key) continue;
      map[key] = Array.isArray(subs)
        ? subs.map(s => String(s).trim()).filter(Boolean)
        : [];
      any = true;
    }
    if (any) return map;
  }
  // Deep-ish copy so callers can't mutate the default
  const copy = {};
  for (const [t, subs] of Object.entries(CASE_TYPE_MAP_DEFAULT)) copy[t] = subs.slice();
  return copy;
}

/* Display convention: "Type: Subtype" when both present, plain type when
   subtype empty. Takes a case-shaped row ({case_type, case_subtype}). */
function fmtCaseType(c) {
  if (!c) return '';
  const t = c.case_type || '';
  const s = c.case_subtype || '';
  return s ? `${t}: ${s}` : t;
}

/* Populate a case-type FILTER <select> from the map. Mirrors the shells'
   eventtypelist populate: static options in the markup (e.g. value="%" All)
   are preserved, dynamic options are tagged data-dyn and replaced on
   re-populate, and the current value is restored so a re-populate never
   clobbers a user's choice.

   Option encoding (types/subtypes are opaque — no delimiter parsing):
     option.value          = visible label (unique, restore-by-value safe)
     option.dataset.type    = case_type to filter on
     option.dataset.subtype = case_subtype to filter on ('' / absent = all)
   A type WITH subtypes yields "Type (all)" + one "Type: Sub" per subtype;
   a type WITHOUT subtypes yields a plain "Type" option.

   Readers should use the selected option's dataset, falling back to value
   for the static options:
     const opt = sel.selectedOptions[0];
     const type = opt ? (opt.dataset.type ?? opt.value) : '%';
     const subtype = (opt && opt.dataset.subtype) || ''; */
function populateCaseTypeFilter(sel) {
  if (!sel) return;
  const prev = sel.value;
  sel.querySelectorAll('option[data-dyn="1"]').forEach(o => o.remove());
  const map = getCaseTypeMap();
  for (const [type, subs] of Object.entries(map)) {
    const add = (label, subtype) => {
      const opt = document.createElement('option');
      opt.value = label;
      opt.textContent = label;
      opt.setAttribute('data-dyn', '1');
      opt.dataset.type = type;
      if (subtype) opt.dataset.subtype = subtype;
      sel.appendChild(opt);
    };
    if (subs.length) {
      add(`${type} (all)`, '');
      subs.forEach(s => add(`${type}: ${s}`, s));
    } else {
      add(type, '');
    }
  }
  if (prev) sel.value = prev;
  if (!sel.value) sel.selectedIndex = 0; // prev label no longer exists
}

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
  customClass: { popup: 'yc-popup' },
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
    customClass: { popup: 'yc-popup' },
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
   Used by a.html, b.html, contact.html, case.html.

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
    /* A glyph acting as a rule, so it takes a border colour rather than a
       text one -- --text-muted would read as another list item. */
    #logTableFoot .sep {
      color: var(--border-strong);
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
      background: var(--hover);
      text-decoration: underline;
    }
    #logTableFoot .log-pagination strong {
      padding: 0.15em 0.5em;
      background: var(--surface-2);
      color: var(--text);
      border-radius: 3px;
      font-weight: bold;
    }
    #logTableFoot .log-pagination-ellipsis {
      color: var(--text-muted);
      padding: 0 0.1em;
    }
    #logTableFoot .logPageInput {
      width: 4.5em;
      text-align: center;
      font-weight: bold;
      padding: 0.15em 0.3em;
      border: 1px solid var(--border-strong);
      background: var(--surface);
      color: var(--text);
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
      /* Track, OFF. --border-strong keeps the light look and lifts the dark
         one; the knob below stays literal white on purpose -- it has to read
         against the track in BOTH modes, so it is mode-independent by design,
         exactly like --fill-text but for a shape rather than a label.
         The knob measures 1.35 on this track in light (it was 1.44 on #ccc)
         and 8.94 in dark; the light figure is under SC 1.4.11 and was before
         this change too. Reported, not silently retuned. */
      background-color: var(--border-strong);
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
    /* Track, ON. --accent is the fill token; the white knob measures 2.55 on
       it (it was 2.90 on #4a90e2). Reaching 3:1 would mean giving this one
       switch a different blue from every other primary control, which is the
       inconsistency the arc exists to remove. Reported. */
    .log-switch input:checked + .log-switch-slider {
      background-color: var(--accent);
    }
    .log-switch input:checked + .log-switch-slider::before {
      transform: translateX(14px);
    }
    .log-switch input:focus-visible + .log-switch-slider {
      box-shadow: 0 0 0 2px var(--accent);
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
      color: var(--text-muted);
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
    ? `<i class="fa-solid ${m[0]}" title="${m[1]}" style="color:var(--text-muted);margin-right:4px;font-size:0.85em"></i>`
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
              style="color:var(--text-muted);cursor:pointer;font-size:0.85em"
              onclick="showLogDetails(${entry.log_id});return false"></i>`;
}

/* ── About-link badge (About-link S3) ─────────────────────────────────────
   Renders in the entity cell of every log feed row, AFTER the primary link.
   Two states:
     · about set  → second line: link icon + hydrated label (about_case_number
                    / about_contact_name from listLog's PK-gated joins;
                    falls back to the raw type:id for unhydrated values, e.g.
                    docket-form about values or appt/bill/task/event types).
                    Click opens LogAboutDialog (change / remove).
     · no about   → a single muted link icon, click opens LogAboutDialog to
                    set one. Mirrors the OrphanAdoptDialog user-plus icon
                    precedent on the global feed: per-row fix-up affordance.

   refreshExpr is a JS EXPRESSION STRING embedded verbatim in the onclick
   (e.g. "() => tabLogGet(0)"); it must contain no quote characters —
   enforced below by failing loudly (empty badge + console.error) rather
   than silently emitting a broken attribute. Only entry.log_id (coerced to
   Number) is interpolated from row data into the handler — every displayed
   string goes through escText/escAttr, same rule as buildLogDataCell
   (about labels are attacker-reachable via the API).

   hasPrimaryLink: whether the cell already rendered a primary entity link.
   When false (exactly the orphan rows this feature exists for), the set-
   state badge renders inline after the type icon instead of opening with a
   dangling <br>. */
function logAboutBadge(entry, refreshExpr, hasPrimaryLink = true) {
  const rid = Number(entry.log_id);
  if (!Number.isInteger(rid) || rid <= 0) return '';
  if (/["']/.test(String(refreshExpr))) {
    console.error('logAboutBadge: refreshExpr must not contain quotes:', refreshExpr);
    return '';
  }
  const open = `LogAboutDialog(${rid}, ${refreshExpr});return false`;

  if (entry.log_about_type) {
    let label;
    if (entry.log_about_type === 'case') {
      label = entry.about_case_number || entry.log_about_id;
    } else if (entry.log_about_type === 'contact') {
      label = entry.about_contact_name || ('Contact ' + entry.log_about_id);
    } else {
      label = entry.log_about_type + ': ' + entry.log_about_id;
    }
    const lead = hasPrimaryLink ? '<br>' : ' ';
    return `${lead}<a href="#" class="log-about-badge" onclick="${open}"
       title="About: ${escAttr(label)} \u2014 click to change or remove"><i class="fa-solid fa-link"></i> ${escText(label)}</a>`;
  }
  return ` <a href="#" class="log-about-add" onclick="${open}"
       title="Link to a case or contact\u2026"><i class="fa-solid fa-link"></i></a>`;
}

/* Once-per-document styles for the badge + LogAboutDialog. Same guarded-IIFE
   pattern as injectContactPickerStyles. */
(function injectLogAboutStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('log-about-styles')) return;
  const style = document.createElement('style');
  style.id = 'log-about-styles';
  style.textContent = `
    .log-about-badge { font-size: 0.85em; color: var(--accent-2, #4a7); text-decoration: none; }
    .log-about-badge:hover { text-decoration: underline; }
    .log-about-badge .fa-link { font-size: 0.9em; }
    .log-about-add { color: var(--text-muted, #888); opacity: 0.55; text-decoration: none; }
    .log-about-add:hover { opacity: 1; }
    .log-about-add .fa-link { font-size: 0.8em; }
    /* Dialog: same dropdown-spill fix as cad/oad/na — let the embedded
       Case/Contact picker escape SWAL's overflow:auto html container. */
    .swal2-html-container.lab-html { overflow: visible; }
    .lab-html .cp-dropdown { max-height: 12em; }
    .lab-current { text-align: left; font-size: 0.92em; margin: 0 0 0.6em; }
    .lab-current:empty { display: none; }
    .lab-kind-row { display: flex; gap: 1.2em; text-align: left; margin: 0 0 0.5em; font-size: 0.95em; }
    .lab-chosen { font-size: 0.85em; color: var(--text-2, #555); margin-top: 0.35em; text-align: left; }
    .lab-chosen:empty { display: none; }
  `;
  document.head.appendChild(style);
})();

/* Escape a string for safe insertion inside an HTML attribute value
   (quoted with double quotes). Also escapes < to avoid breaking out of
   attribute context if the browser tolerates malformed input. */
function escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/* Escape a string for insertion as TEXT between tags (innerHTML sinks).
   & and < are the two that actually matter in text context; > " ' are
   escaped too so this is safe to reuse in either context without thinking.
   Entities render back to the literal characters, so there is no visual
   change to the escaped output.

   & MUST be replaced first or the entities we insert get double-escaped. */
function escText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Build the Data cell HTML — each key gets its own .log-data-row line,
   with a title attribute carrying the full value for hover-reveal.

   EVERYTHING here is attacker-reachable and lands in innerHTML: log_data is
   written by the email/phone ingest pipelines, by court-email parsing, and
   (since the task cancel/complete note) by an UNAUTHENTICATED endpoint. Keys
   AND values AND the raw non-JSON fallback all go through escText. Do not
   interpolate anything from `entry` here without escaping it. */
function buildLogDataCell(entry) {
  let inner;
  try {
    const raw = (entry.log_data || '').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    const jsonData = JSON.parse(raw);
    // Case-insensitive de-dupe: some legacy/ingest rows carry both a cased
    // and lowercase twin of the same field (e.g. From + from), which would
    // otherwise render as two identical rows. Keep the first occurrence of
    // each case-folded key; the canonical (usually cased) key wins because
    // writers emit it first.
    const seen = new Set();
    const keys = Object.keys(jsonData).filter(k => {
      const lc = k.toLowerCase();
      if (seen.has(lc)) return false;
      seen.add(lc);
      return true;
    });
    inner = keys.map(key => {
      let v = jsonData[key];
      try { v = decodeURIComponent(String(v)); } catch { /* leave as-is */ }
      const titleSafe = escAttr(v);
      return `<div class="log-data-row" title="${titleSafe}"><b>${escText(key)}:</b> ${escText(v)}</div>`;
    }).join('');
  } catch {
    const raw = entry.log_data || '';
    inner = `<div class="log-data-row" title="${escAttr(raw)}">${escText(raw)}</div>`;
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
      // Case-insensitive de-dupe to match buildLogDataCell — drop lowercase
      // twins of cased keys so the inspector mirrors what the cell shows.
      const seen = new Set();
      decodedData = Object.fromEntries(
        Object.entries(parsed)
          .filter(([k]) => {
            const lc = k.toLowerCase();
            if (seen.has(lc)) return false;
            seen.add(lc);
            return true;
          })
          .map(([k, v]) => {
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
      // About-link S3.1: secondary attribution, hydrated by getLogEntry's
      // PK-gated joins. Mirrors the badge so the inspector never omits a
      // field the row shows. null (not an empty block) when unset.
      about: e.log_about_type ? {
        type:  e.log_about_type,
        id:    e.log_about_id,
        label: e.about_case_number || e.about_contact_name || null,
      } : null,
      message: e.log_message || null,
      data:    decodedData,
      extra:   e.log_extra || null,
    };

    const escaped = JSON.stringify(payload, null, 2)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    Swal.fire({
      customClass: { popup: 'yc-popup' },
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

/* Footer for the Events tab — log-style pagination (reuses renderLogPagination)
   plus a "Showing N–M of T" meta, a limit dropdown, and Print. Deliberately
   leaner than renderLogFooter (no expand toggle / export). jumpFn(pageNum) is
   1-based; limitChange(newLimit) lets the caller re-fetch at a new page size. */
function renderEventsFooter(containerEl, total, limit, offset, shownCount, jumpFn, limitChange) {
  containerEl.innerHTML = '';
  total = total || 0;
  const shownStart = total === 0 ? 0 : offset + 1;
  const shownEnd = Math.min(total, offset + (shownCount || 0));

  const pagWrap = document.createElement('span');
  pagWrap.className = 'log-pagination';
  containerEl.appendChild(pagWrap);
  renderLogPagination(pagWrap, total, limit, offset, jumpFn);

  const meta = document.createElement('span');
  meta.innerHTML = `<span class="sep">|</span> Showing ${shownStart}–${shownEnd} of ${total}`;
  containerEl.appendChild(meta);

  const limitWrap = document.createElement('span');
  limitWrap.innerHTML = `<span class="sep">|</span> Limit
    <select style="width:auto">
      <option value="50"  ${limit == 50 ? 'selected' : ''}>50</option>
      <option value="100" ${limit == 100 ? 'selected' : ''}>100</option>
      <option value="200" ${limit == 200 ? 'selected' : ''}>200</option>
      <option value="500" ${limit == 500 ? 'selected' : ''}>500</option>
    </select>`;
  containerEl.appendChild(limitWrap);
  const limSel = limitWrap.querySelector('select');
  if (limSel && typeof limitChange === 'function') {
    limSel.addEventListener('change', () => limitChange(limSel.value));
  }

  const btnWrap = document.createElement('span');
  btnWrap.innerHTML = `<span class="sep">|</span> <button type="button" class="log-print-btn">Print</button>`;
  containerEl.appendChild(btnWrap);
  btnWrap.querySelector('.log-print-btn').addEventListener('click', () => window.print());
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
    customClass: { popup: 'yc-popup' },
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
              ? '<span style="color:var(--danger);font-size:0.88em;margin-left:0.4em">— large, may be slow or fail</span>'
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
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border-strong);
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
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }
    .cp-row:last-child { border-bottom: none; }
    .cp-row:hover, .cp-row.cp-active { background: var(--hover); }
    .cp-row .cp-name { font-weight: bold; }
    /* --text-2, not --text-muted: on the hovered/active row (--hover) muted
       measures 4.43 in dark. --text-2 is 4.55 light / 6.97 dark there, and
       "secondary text" is the role this line actually is. */
    .cp-row .cp-sub { font-size: 0.85em; color: var(--text-2); }
    .cp-empty { padding: 0.4em 0.6em; color: var(--text-muted); font-size: 0.9em; background: var(--surface); }

    /* ── Header / value ── */
    .oad-header { margin-bottom: 0.4em; }
    .oad-value { font-size: 1.15em; font-weight: bold; }
    .oad-earliest { font-size: 0.8em; color: var(--text-muted); }

    /* ── De-emphasized top half (the start-date is rarely touched) ──
       Muted, smaller, set apart by a hairline below it so the eye drops
       past it to the search/create area, which is the primary action. */
    .oad-startdate-row {
      margin: 0.3em 0 0.7em;
      padding-bottom: 0.7em;
      border-bottom: 1px solid var(--border);
      text-align: center;
      color: var(--text-muted);
      font-size: 0.85em;
    }
    .oad-startdate-row input[type="date"] {
      font-size: 0.85em;
      padding: 0.15em 0.3em;
      color: var(--text-2);
    }

    /* ── Primary area: matches, create, search ── */
    .oad-section-label { font-weight: bold; font-size: 0.9em; margin: 0.6em 0 0.2em; text-align: left; }
    .oad-match {
      display: flex; align-items: center; justify-content: space-between;
      gap: 0.5em; padding: 0.4em 0.5em; border: 1px solid var(--border);
      border-radius: 4px; margin-bottom: 0.3em; text-align: left;
    }
    .oad-match.oad-selected { border-color: var(--accent); background: var(--accent-soft); }
    .oad-match .oad-match-name { font-weight: bold; }
    .oad-match .oad-match-src { font-size: 0.8em; color: var(--text-2); }

    /* Create-new button — bolder than a plain SWAL secondary so it reads as
       a real alternative to attaching. Outlined accent style. */
    .oad-create-btn {
      font-weight: bold;
      font-size: 0.95em;
      padding: 0.45em 1.1em;
      /* Outlined accent button: the LABEL is --accent-2 (--accent as text is
         2.55), the border is --accent, and the filled hover flips to
         --accent + --accent-text. #2563eb was a fourth blue. */
      color: var(--accent-2);
      background: var(--surface);
      border: 2px solid var(--accent);
      border-radius: 5px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .oad-create-btn:hover { background: var(--accent); color: var(--accent-text); }

    /* Let the ContactPicker dropdown spill out of SWAL's html container
       instead of being clipped by its overflow:auto / max-height. The
       dropdown is position:absolute within .cp-wrap, so the ancestor must
       not clip. SWAL sets overflow:auto inline via its stylesheet, hence
       the override. */
    .swal2-html-container.oad-html { overflow: visible; }
    .oad-html .cp-dropdown { max-height: 12em; }
    /* ── CasePicker rows (Phase 3) ── */
    .cp-case-row .cp-case-num { font-weight: bold; font-size: 1.05em; }
    .cp-case-row .cp-sub { font-size: 0.85em; color: var(--text-2); }

    /* ── CaseAdoptDialog (Phase 4.1) ── */
    /* Same dropdown-spill fix as oad-html: let the CasePicker dropdown escape
       SWAL's overflow:auto html container instead of being clipped. */
    .swal2-html-container.cad-html { overflow: visible; }
    .cad-html .cp-dropdown { max-height: 12em; }
    .cad-fields { display: flex; gap: 0.6em; margin: 0.3em 0 0.6em; text-align: left; }
    .cad-field { flex: 1; }
    .cad-field label { display: block; font-size: 0.8em; color: var(--text-muted); margin-bottom: 0.15em; }
    .cad-field input { width: 100%; box-sizing: border-box; }
    .cad-hint { font-size: 0.82em; color: var(--warn); margin: 0 0 0.5em; text-align: left; }
    .cad-section-label { font-weight: bold; font-size: 0.9em; margin: 0.6em 0 0.2em; text-align: left; }
    .cad-preview {
      margin-top: 0.6em; padding: 0.45em 0.6em; text-align: left;
      font-size: 0.88em; color: var(--text-2); background: var(--surface-2);
      border: 1px solid var(--border); border-radius: 4px; min-height: 1.2em;
    }
    .cad-preview:empty { display: none; }
    .cad-preview .cad-count { font-weight: bold; color: var(--text); }

    /* ── NewCaseForm (Phase 4.2) ── */
    /* Same dropdown-spill fix as oad-html / cad-html: let the embedded
       ContactPicker dropdown escape SWAL's overflow:auto html container. */
    .swal2-html-container.ncf-html { overflow: visible; }
    .ncf-html .cp-dropdown { max-height: 12em; }
    .ncf-field { margin: 0 0 0.6em; text-align: left; }
    .ncf-field label { display: block; font-size: 0.8em; color: var(--text-muted); margin-bottom: 0.15em; }
    .ncf-field input, .ncf-field select { width: 100%; box-sizing: border-box; }
    .ncf-docket-row { display: flex; gap: 0.6em; }
    .ncf-docket-row .ncf-field { flex: 1; }
    .ncf-section-label { font-weight: bold; font-size: 0.9em; margin: 0.6em 0 0.2em; text-align: left; }
    /* Mirror cad's create button so the adopt dialog's two buttons match. */
    .cad-create-btn {
      font-weight: bold;
      font-size: 0.95em;
      padding: 0.45em 1.1em;
      color: var(--accent-2);
      background: var(--surface);
      border: 2px solid var(--accent);
      border-radius: 5px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .cad-create-btn:hover { background: var(--accent); color: var(--accent-text); }
    .cad-create-row { margin: 0.6em 0 0.2em; text-align: left; }

    /* ── newApptDialog (shared appt creator) ── */
    /* Same dropdown-spill fix: let embedded Contact/Case pickers escape SWAL's
       overflow:auto html container instead of being clipped. */
    .swal2-html-container.na-html { overflow: visible; }
    .na-html .cp-dropdown { max-height: 12em; }
    .na-field { margin: 0 0 0.5em; text-align: left; }
    .na-field > label { display: block; font-size: 0.8em; color: var(--text-muted); margin-bottom: 0.15em; }
    .na-fixed { text-align: left; margin: 0 0 0.5em; font-size: 0.95em; }
    .na-section-label { font-weight: bold; font-size: 0.9em; margin: 0.6em 0 0.2em; text-align: left; }
    .na-chosen { font-size: 0.85em; color: var(--text-2); margin-top: 0.25em; text-align: left; }
    .na-chosen:empty { display: none; }
    .na-change { font-size: 0.82em; margin-left: 0.5em; color: var(--accent-2); }
    /* slot picker (scheduler slice 4) */
    .na-slot-row { display: flex; align-items: center; gap: 0.5em; margin: 0.5em 0 0.2em; text-align: left; }
    .na-slot-row > label { font-size: 0.9em; }
    .na-slots { display: flex; flex-wrap: wrap; gap: 0.35em; margin: 0.4em 0 0.2em;
      text-align: left; max-height: 9.5em; overflow-y: auto; }
    .na-slot { font-size: 0.85em; padding: 0.3em 0.6em; border: 1px solid var(--accent);
      border-radius: 4px; background: var(--surface); color: var(--accent-2); cursor: pointer;
      transition: background 0.12s, color 0.12s; }
    .na-slot:hover { background: var(--accent-soft); }
    .na-slot.na-slot-sel { background: var(--accent); color: var(--accent-text); }
    .na-slot-msg { font-size: 0.85em; color: var(--text-muted); text-align: left; margin: 0.3em 0; }
    .na-slot-msg:empty { display: none; }
    .na-manual-toggle { font-size: 0.82em; color: var(--accent-2); display: inline-block; margin: 0.2em 0 0.4em; }

    /* ── newEventDialog (shared event creator/editor) ── */
    .ne-form { text-align: left; max-width: 460px; margin: 0 auto; }
    .ne-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5em 0.8em; }
    .ne-row  { display: flex; flex-direction: column; }
    .ne-row.ne-full { grid-column: 1 / -1; }
    .ne-row > label {
      font-size: 0.75em; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.03em; margin: 0 0 0.15em;
    }
    .ne-form input:not([type=checkbox]),
    .ne-form select,
    .ne-form textarea {
      width: 100%; box-sizing: border-box; margin: 0;
      font-size: 0.95em; padding: 0.4em 0.5em;
    }
    .ne-form textarea { height: 56px; resize: vertical; }
    .ne-allday { flex-direction: row; align-items: center; gap: 0.4em; }
    .ne-allday > label { font-size: 0.9em; font-weight: 500; color: var(--text);
      text-transform: none; letter-spacing: 0; display: flex; align-items: center; gap: 0.4em; margin: 0; }
    .ne-allday input[type=checkbox] { width: auto; }
    .ne-section { grid-column: 1 / -1; font-weight: 700; font-size: 0.8em;
      color: var(--text-2); text-transform: uppercase; letter-spacing: 0.04em;
      margin: 0.5em 0 -0.1em; border-top: 1px solid var(--border); padding-top: 0.6em; }
    .ne-form .na-fixed { font-size: 0.92em; margin: 0; }
    .na-html.ne-html .cp-dropdown { max-height: 11em; }

    /* ── The dialogs' own card ──────────────────────────────────────────
       Everything above is tokenised, and SweetAlert2 paints .swal2-popup
       white with #545454 text in BOTH modes. Of the twenty pages that load
       this file, exactly two override that (index.html for the shell,
       videoManager.html for itself), so without this the picker rows, the
       adopt dialog and the name-slot widget would be themed content sitting
       on an unthemed white card — near-white --text on white in dark.

       Scoped through customClass to the dialogs THIS file fires, not to
       .swal2-popup globally: making every SweetAlert on all twenty pages
       follow the theme is the right end state and is a much bigger change
       than a literal conversion. Reported with slice 10.

       The three rules are the same ones index.html:428-442 already ships. */
    .yc-popup { background: var(--surface); color: var(--text); }
    .yc-popup .swal2-title,
    .yc-popup .swal2-html-container { color: var(--text); }
    .yc-popup input:not([type=radio]):not([type=checkbox]),
    .yc-popup select,
    .yc-popup textarea {
      background: var(--surface); color: var(--text); border: 1px solid var(--border);
    }
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
     L3 (muted):     [case_caption — ] primary_contact_name || '(no primary contact)'

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

      // L2 — case_id · case_type[: case_subtype] · case_stage
      const meta = [r.case_id, fmtCaseType(r), r.case_stage].filter(Boolean).join('  ·  ');
      const line2 = document.createElement('div');
      line2.className = 'cp-sub';
      line2.textContent = meta;
      row.appendChild(line2);

      // L3 — caption (when set) + primary contact
      const line3 = document.createElement('div');
      line3.className = 'cp-sub';
      const cpWho = r.primary_contact_name || '(no primary contact)';
      line3.textContent = r.case_caption ? `${r.case_caption} \u2014 ${cpWho}` : cpWho;
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

   The new-client intake dialog. Creates a contact and, optionally, a case
   ("Add & Open Case" or any Case Type chosen on the client path) and an
   optional first appointment — all in one flow, no hand-off.

   Appointment block: revealed by the "Schedule first appointment" checkbox.
   Fields: With (does_appts users, default = lowest-id, i.e. Stuart, resolved
   live), Type, Method, datetime, Notes, and confirmation SMS/Email with an
   auto-filled message. The appt is attached to the case the intake created,
   when there is one.

   prefill (all optional):
     name / phone / email      — pre-fill the fields.
     phone_start_date /
     email_start_date          — show + send the corresponding start-date input.
     force_create              — intake skips find-or-create (sends duplicate flag).
     suppressOpen              — don't open the new contact/case file after create
                                 (used by the orphan-adopt "create new" flows).
   onSuccess(data)             — fires after a successful create; data is the
                                 contact result (client path) or case result
                                 (case path). Callers read data.status/id/name.
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

  // appt_with options (lowest-id does_appts user default)
  const firm = (typeof window !== 'undefined' && window.firmData)
    ? window.firmData
    : ((P && P.firmData) || {});
  const apptUsers = (firm.users || [])
    .filter(u => u.does_appts)
    .sort((a, b) => a.user - b.user);
  const defaultWith = apptUsers.length ? String(apptUsers[0].user) : '';
  const withOptions = apptUsers
    .map(u => `<option value="${u.user}"${String(u.user) === defaultWith ? ' selected' : ''}>with ${escAttr(u.user_name)}</option>`)
    .join('');

  // Minimal inline appt block — hidden until the checkbox is ticked.
  const apptBlockHtml = `
    <label class="input-label">Appt:</label>
    <label class="sub-label" style="text-align:left; width:auto;">
      <input type="checkbox" id="NCApptOn" style="width:auto;"> Schedule first appointment <i style="color:var(--text-muted);">(optional)</i>
    </label><br>
    <!-- The controls in this box are one 320px stack. It was 280px until
         style.css got a 320px min-width floor on datetime-local inside a
         swal2 popup (the type's UA shadow content clips below that); the
         floor would have pushed #NCApptDate 40px wider than everything
         around it, so the stack moved with it. #NCApptType is 240 rather
         than 320 because it shares its row with #NCApptLen (60px) and a
         collapsed whitespace gap -- the pair lands ~16px short of the
         stack, exactly as it did at 200+60 against 280. The box is inside a
         32em popup with ~442px of content width, so 320 clears it. -->
    <div id="NCApptBox" style="display:none; border:1px solid var(--border); border-radius:5px; padding:8px; margin:4px 0; text-align:center;">
      <form onchange="newContact._recompute && newContact._recompute()">
      <select id="NCApptWith" style="width:320px;">${withOptions}</select><br>
      <select id="NCApptTypeSel" style="width:320px; margin-top:6px;"
        onchange="[E('NCApptType').value,E('NCApptLen').value]=this.value.split(',');E('NCApptOtherSpan').style.display=this.value==','?'':'none'">
        <option disabled selected>Appointment Type:</option>
        <!-- "Initial Strategy Session" is deliberately ONLY offered here, in the
             new-client dialog. It is the first-contact appointment type and it
             is the cascade key for the pre_appt "Initial Strategy Session"
             sequence template (welcome video + intake-form nag chain), which is
             wrong for an existing client. The shared newApptDialog() — used by
             case.html, contact.html, calendar.html and the shell Appointments
             tab — deliberately does NOT list it; those surfaces book follow-ups
             for clients who already exist. Keep the string byte-identical to
             sequence_templates.filters -> appt_type or the cascade silently
             falls through to the generic fallback template. -->
        <option value="Initial Strategy Session,15">Initial Strategy Session (15 min)</option>
        <option value="Strategy Session,15">Strategy Session (15 min)</option>
        <option value="Strategy Session Follow Up,15">Strategy Session Follow Up (15 min)</option>
        <option value="Strategy Session Follow Up,30">Strategy Session Follow Up (30 min)</option>
        <option value="Pre-filing Meeting,30">Pre-filing Meeting (30 min)</option>
        <option value="Schedules Completion Meeting,45">Schedules Completion Meeting (45 min)</option>
        <option value="Documents Completion Meeting,30">Documents Completion Meeting (30 min)</option>
        <option value="Matrix Completion Meeting,15">Matrix Completion Meeting (15 min)</option>
        <option value=",">Other</option>
      </select><br>
      <span id="NCApptOtherSpan" style="display:none;">
        <input id="NCApptType" style="width:240px;" placeholder="Other type">
        <input id="NCApptLen" style="width:60px;" maxlength="3" oninput="this.value=isNaN(this.value)?'':this.value" placeholder="min">
      </span><br>
      <span style="font-size:0.85em;">Method:
        <input type="radio" name="NCApptPlatform" id="NCApptTel" value="telephone" style="width:auto;" checked><label for="NCApptTel">Tel</label>
        <input type="radio" name="NCApptPlatform" id="NCApptZoom" value="Zoom" style="width:auto;"><label for="NCApptZoom">Zoom</label>
        <input type="radio" name="NCApptPlatform" id="NCApptIP" value="in-person" style="width:auto;"><label for="NCApptIP">In-person</label>
      </span><br>
      <input type="datetime-local" id="NCApptDate" style="width:320px; margin-top:6px;"><br>
      <textarea id="NCApptNote" placeholder="Appointment notes (optional)" style="width:320px; height:48px; margin-top:6px;"></textarea><br>
      <span style="font-size:0.85em;">Confirmation:
        <input type="checkbox" id="NCApptSMS" style="width:auto;"><label for="NCApptSMS">SMS</label>
        <input type="checkbox" id="NCApptEmail" style="width:auto;"><label for="NCApptEmail">Email</label>
      </span><br>
      </form>
      <textarea id="NCApptConfirmMsg" style="display:none; width:320px; height:54px; margin-top:4px; resize:none;"></textarea>
    </div>`;

  // Hidden mirror inputs (NCApptType/NCApptLen live in the Other span; the
  // type-select writes into them even while hidden — same trick as newAppt).
  // We DON'T add duplicate IDs here: NCApptType/NCApptLen exist once, inside
  // the Other span. The preset options set their .value via the select.

  Swal.fire({
    customClass: { popup: 'yc-popup' },
    title: "Add New Client:",
    html: `<label class="input-label">Name:</label>
         <input style="width:200px;" type="text" id="NCName" placeholder="Full Name"><br>
         <label class="input-label">Phone:</label>
         <input style="width:200px;" id="NCPhone" type="text" placeholder="(###) ###-####" title="Enter a valid phone number"><br>
         ${phoneStartHtml}
         <label class="input-label">Email:</label>
         <input style="width:200px;" id="NCEmail" type="text" placeholder="Email Address"><br>
         ${emailStartHtml}
         <label class="input-label">Case Type:</label>
         <select id="NCType" style="width:200px;" onchange="E('NCOtherType').style.display = this.value === 'Other' ? '' : 'none';">
          <option selected value="">Select a case type</option>
          <option>Bankruptcy</option>
          <option>Other</option>
         </select>
         <input style="width:200px; display:none;" type="text" id="NCOtherType" placeholder="Enter case type"><br>
         <label class="sub-label">Optional, select type to open a case.</label><br>
         ${apptBlockHtml}
         `,
    showCancelButton: true,
    showConfirmButton: true,
    cancelButtonText: "Cancel",
    confirmButtonText: "Add & Open Client",
    showCloseButton: true,
    showDenyButton: true,
    denyButtonText: "Add & Open Case",
    // The app's third blue (charter section 7 maps #26abe2 -> --accent).
    denyButtonColor: "var(--accent)",
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
      if (defaultWith && E("NCApptWith")) E("NCApptWith").value = defaultWith;
      const on = E("NCApptOn");
      if (on) on.addEventListener("change", () => {
        E("NCApptBox").style.display = on.checked ? "" : "none";
      });
      // Confirmation-message auto-fill (parallels newApptDialog.recompute).
      newContact._recompute = function () {
        const dt = E("NCApptDate") ? E("NCApptDate").value : '';
        const date = dt
          ? new Date(dt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }).replace(',', ' at')
          : '';
        const hasCom = (E("NCApptSMS") && E("NCApptSMS").checked) || (E("NCApptEmail") && E("NCApptEmail").checked);
        const box = E("NCApptConfirmMsg");
        if (!box) return;
        box.style.display = hasCom ? '' : 'none';
        if (hasCom && dt) {
          const len  = E("NCApptLen") ? E("NCApptLen").value : '';
          const plat = (document.querySelector('input[name="NCApptPlatform"]:checked') || {}).value || '';
          const type = E("NCApptType") ? E("NCApptType").value : '';
          box.value = `This is to confirm that I scheduled you for a ${len} minute ${plat} ${type} on ${date}.  To view or change it: https://4lsg.com/m/{{appts.appt_manage_token|default:}}`;
        }
      };
    },

    willClose: () => { delete newContact._recompute; },

    // Shared validation + create. mode: 'client' | 'case'
    preConfirm:  () => _ncInlineSubmit('client'),
    preDeny:     () => _ncInlineSubmit('case'),
    allowOutsideClick: () => !Swal.isLoading()

  }).then((result) => {
    if (!result.isConfirmed && !result.isDenied) return;
    if (!result.value) return;
    const { type, data, apptResult } = result.value;

    Toast.fire({
      icon: data.status || "success",
      title: data.status === "success" ? "Success" : "Error",
      text: data.message
    });
    if (apptResult) {
      Toast.fire({
        icon: apptResult.status || 'success',
        title: apptResult.title || 'Appointment',
        text: apptResult.message
      });
    }

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

  // ── shared submit for both buttons ──
  async function _ncInlineSubmit(mode) {
    const name = E("NCName").value.trim();
    const phone = E("NCPhone").value.replace(/\D/g, "");
    const email = E("NCEmail").value.trim();
    const caseTypeRaw = E("NCType").value;
    const caseType = caseTypeRaw === "Other" ? E("NCOtherType").value.trim() : caseTypeRaw;

    // ── Contact validation (shared) ──
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
    // ── Case-type rules differ by button ──
    if (mode === 'case' && !caseType) {
      Swal.showValidationMessage("Please select a case type");
      return false;
    }
    if (caseTypeRaw === "Other" && !caseType) {
      Swal.showValidationMessage("Please enter a case type");
      return false;
    }

    // ── Appt validation (only if scheduling) ──
    const apptOn = E("NCApptOn") && E("NCApptOn").checked;
    let apptType, apptLen, apptDate, apptWith, apptPlatform;
    if (apptOn) {
      apptType = E("NCApptType") ? E("NCApptType").value : '';
      apptLen  = E("NCApptLen")  ? E("NCApptLen").value  : '';
      apptWith = E("NCApptWith") ? E("NCApptWith").value : '';
      apptPlatform = (document.querySelector('input[name="NCApptPlatform"]:checked') || {}).value || '';
      const dtRaw = E("NCApptDate") ? E("NCApptDate").value : '';
      if (!apptType || !apptLen || !dtRaw) {
        Swal.showValidationMessage("Complete the appointment type, length, and date — or untick 'Schedule first appointment'.");
        return false;
      }
      if (!apptWith) {
        Swal.showValidationMessage("Pick who the appointment is with.");
        return false;
      }
      apptDate = dtRaw.replace("T", " ") + ":00";
      if (whenDate(apptDate) === "past") {
        Swal.showValidationMessage("Please choose a future appointment date.");
        return false;
      }
    }

    try {
      const body = { name, phone, email };
      if (hasPhoneStart && E("NCPhoneStart") && E("NCPhoneStart").value) body.phone_start_date = E("NCPhoneStart").value;
      if (hasEmailStart && E("NCEmailStart") && E("NCEmailStart").value) body.email_start_date = E("NCEmailStart").value;
      if (forceCreate) body.duplicate = "duplicate";

      // 1) contact
      const contactResult = await P.apiSend("/api/intake/contact", "POST", body);

      // 2) case (always for 'case' mode; for 'client' mode only if type chosen)
      let caseResult = null;
      if (mode === 'case' || caseType) {
        caseResult = await P.apiSend("/api/intake/case", "POST", {
          contact_id: contactResult.id,
          case_type: caseType
        });
      }

      // 3) appt (optional) — attach the created case if there is one
      let apptResult = null;
      if (apptOn) {
        const apptBody = {
          contact_id:    contactResult.id,
          appt_type:     apptType,
          appt_length:   apptLen,
          appt_platform: apptPlatform,
          appt_date:     apptDate,
          appt_with:     apptWith,
          note:            E("NCApptNote") ? E("NCApptNote").value : '',
          confirm_sms:     E("NCApptSMS")   ? E("NCApptSMS").checked   : false,
          confirm_email:   E("NCApptEmail") ? E("NCApptEmail").checked : false,
          confirm_message: E("NCApptConfirmMsg") ? E("NCApptConfirmMsg").value : '',
        };
        if (caseResult && caseResult.id != null) apptBody.case_id = caseResult.id;
        apptResult = await P.apiSend("/api/appts", "POST", apptBody);
      }

      const data = (mode === 'case') ? caseResult : contactResult;
      return { type: mode, data, contactData: contactResult, caseData: caseResult, apptResult };
    } catch (err) {
      Swal.showValidationMessage(err.message || "Failed to create");
      return false;
    }
  }
}


/* ──────────────────────────────────────────────────────────────────────────
   newApptDialog(opts)   (shared appointment creator)

   One dialog for the standalone appt surfaces (a/b shell appts tab, case,
   contact). Sends appt_with explicitly (the per-file SWALs it replaced never
   did, so every booked appt defaulted server-side to user 1 / Stuart).

   The dialog has two SIDES — contact and case — that cross-constrain:

     CONTACT side (a client is always required):
       contactFixed: { id, label }   — locked, shown as a line.
       contactList:  [ {contact_id, contact_name, relate_type}, … ]  — <select>.
         contactDefaultPrimary: true (default) → preselect the 'Primary' row.
       contactPick:  true            — typeahead ContactPicker.
       (legacy: contactId/contactLabel ⇒ contactFixed; caseContacts ⇒ list.)

     CASE side (optional):
       caseFixed: { id, label }      — locked, shown as a line.
       caseList:  [ {case_id, case_number, case_number_full, case_type}, … ]
         caseRequired: true → no '— none —' option (default false = optional).
       casePick:  true               — typeahead CasePicker.
       (omit all three ⇒ no case attach. legacy: caseId/caseLabel ⇒ caseFixed;
        allowCasePick ⇒ casePick.)

     CROSS-CONSTRAIN (shell two-sided): when a side is a picker and the OTHER
     side resolves, this side is fetched and collapsed into a <select>:
       pick a contact → GET /api/contacts/:id/cases  → case side becomes an
                        optional <select> of that contact's cases.
       pick a case    → GET /api/cases/:id/contacts  → contact side becomes a
                        required <select> defaulting to Primary.
     A 'change' link reverts a cross-populated side back to its picker.

     defaultDate  'YYYY-MM-DDTHH:mm' — pre-fill the datetime.
     onCreated    fn(data) — fired after a successful create; the caller
                  refreshes its own surface (the dialog stays surface-agnostic).

   appt_with: seeded from firmData.users where does_appts, sorted by user id,
   lowest-id user preselected (Stuart today — resolved live, never hardcoded).
   ────────────────────────────────────────────────────────────────────────── */
function newApptDialog(opts = {}) {
  // ── Normalize the two "sides" (contact, case) from caller opts. ──────────
  // Each side ends up in one of three modes:
  //   'fixed'  — locked id, just shown as a line.
  //   'list'   — a preloaded array → <select>.
  //   'pick'   — a typeahead picker (ContactPicker / CasePicker).
  // On the shell, a side starts as 'pick'; resolving the OTHER side fetches
  // this side's candidates and swaps it to 'list' (cross-constrain). A
  // "change" link reverts a cross-populated side back to 'pick'.
  //
  // Back-compat shims for the prior flat opts (caseId/contactId/caseContacts/
  // allowCasePick) so existing call sites keep working while we migrate them.
  const contactSide = {
    mode:   null,
    fixedId: null, fixedLabel: '',
    list:   null,            // [{contact_id, contact_name, relate_type}]
    required: true,          // a contact is always required to book
    defaultPrimary: false,
    selectedId: null,
    pickerHostId: 'naContactHost',
    crossPopulated: false,   // was this side filled by resolving the case side?
    drove: false,            // did the user pick this side (vs. caller-fixed)?
  };
  const caseSide = {
    mode:   null,
    fixedId: null, fixedLabel: '',
    list:   null,            // [{case_id, case_number, case_number_full, ...}]
    allowEmpty: true,        // a case is optional
    selectedId: null,
    pickerHostId: 'naCaseHost',
    drove: false,            // did the user pick this side (vs. caller-fixed)?
    crossPopulated: false,
  };

  // Contact side from opts
  if (opts.contactFixed && opts.contactFixed.id != null) {
    contactSide.mode = 'fixed';
    contactSide.fixedId = opts.contactFixed.id;
    contactSide.fixedLabel = opts.contactFixed.label || ('Contact ' + opts.contactFixed.id);
    contactSide.selectedId = opts.contactFixed.id;
  } else if (opts.contactId != null) {                       // legacy flat
    contactSide.mode = 'fixed';
    contactSide.fixedId = opts.contactId;
    contactSide.fixedLabel = opts.contactLabel || ('Contact ' + opts.contactId);
    contactSide.selectedId = opts.contactId;
  } else if (Array.isArray(opts.contactList)) {
    contactSide.mode = 'list';
    contactSide.list = opts.contactList;
    contactSide.defaultPrimary = opts.contactDefaultPrimary !== false;
  } else if (Array.isArray(opts.caseContacts)) {             // legacy flat (case)
    contactSide.mode = 'list';
    contactSide.list = opts.caseContacts;
    contactSide.defaultPrimary = true;
  } else {
    contactSide.mode = 'pick';
  }

  // Case side from opts
  if (opts.caseFixed && opts.caseFixed.id != null) {
    caseSide.mode = 'fixed';
    caseSide.fixedId = opts.caseFixed.id;
    caseSide.fixedLabel = opts.caseFixed.label || ('Case ' + opts.caseFixed.id);
    caseSide.selectedId = opts.caseFixed.id;
  } else if (opts.caseId != null) {                          // legacy flat fixed
    caseSide.mode = 'fixed';
    caseSide.fixedId = opts.caseId;
    caseSide.fixedLabel = opts.caseLabel || ('Case ' + opts.caseId);
    caseSide.selectedId = opts.caseId;
  } else if (Array.isArray(opts.caseList)) {
    caseSide.mode = 'list';
    caseSide.list = opts.caseList;
    caseSide.allowEmpty = opts.caseRequired !== true;
  } else if (opts.casePick || opts.allowCasePick) {          // pick (shell) / legacy
    caseSide.mode = 'pick';
  } else {
    caseSide.mode = 'none';                                  // no case attach at all
  }

  // ── firmData / appt_with select (lowest-id does_appts user is default) ──
  const firm = (typeof window !== 'undefined' && window.firmData)
    ? window.firmData
    : ((P && P.firmData) || {});
  const apptUsers = (firm.users || [])
    .filter(u => u.does_appts)
    .sort((a, b) => a.user - b.user);
  const defaultWith = apptUsers.length ? String(apptUsers[0].user) : '';
  const withOptions = apptUsers
    .map(u => `<option value="${u.user}"${String(u.user) === defaultWith ? ' selected' : ''}>with ${escAttr(u.user_name)}</option>`)
    .join('');

  // ── Render helpers for each side (into its host div) ─────────────────────
  function caseLabelOf(row) {
    const numRaw = (row && (row.case_number_full || row.case_number)) || '';
    return (numRaw && numRaw !== row.case_id) ? numRaw : ('Case ' + (row.case_id ?? ''));
  }

  // Active picker handles (so we can destroy on close / on side-swap)
  let contactPicker = null;
  let casePicker = null;

  function destroyContactPicker() { if (contactPicker) { contactPicker.destroy(); contactPicker = null; } }
  function destroyCasePicker()    { if (casePicker)    { casePicker.destroy();    casePicker = null; } }

  // Render the CONTACT side into its host according to contactSide.mode.
  function renderContactSide() {
    const host = E(contactSide.pickerHostId);
    if (!host) return;
    destroyContactPicker();
    host.innerHTML = '';

    if (contactSide.mode === 'fixed') {
      const chgLink = contactSide.drove
        ? ` <a href="#" id="naContactChange" class="na-change">change</a>` : '';
      host.innerHTML = `<div class="na-fixed"><b>Client:</b> ${escAttr(contactSide.fixedLabel)}${chgLink}</div>`;
      const chg = E('naContactChange');
      if (chg) chg.addEventListener('click', (e) => { e.preventDefault(); revertToPickers(); });
      return;
    }
    if (contactSide.mode === 'list') {
      const list = contactSide.list || [];
      const primary = contactSide.defaultPrimary
        ? list.find(c => (c.relate_type || c.case_relate_type) === 'Primary')
        : null;
      const single = list.length === 1;
      const lockNote = contactSide.crossPopulated
        ? ` <a href="#" id="naContactChange" class="na-change">change</a>` : '';
      let sel = `<select id="naContactSel" style="width:300px;">`;
      if (!single && !primary) sel += `<option disabled selected value="">Select a client</option>`;
      list.forEach(c => {
        const rel = c.relate_type || c.case_relate_type || '';
        const label = rel
          ? `${c.contact_id} - ${escAttr(c.contact_name || '')} (${escAttr(rel)})`
          : `${c.contact_id} - ${escAttr(c.contact_name || '')}`;
        const isDefault = primary && c.contact_id === primary.contact_id;
        sel += `<option value="${c.contact_id}"${isDefault ? ' selected' : ''}>${label}</option>`;
      });
      sel += `</select>`;
      host.innerHTML = `<label>Client${contactSide.required ? '' : ' (optional)'}</label>${sel}${lockNote}`;
      // Establish selectedId from the rendered select (default/primary/single).
      const selEl = E('naContactSel');
      contactSide.selectedId = selEl ? (selEl.value || null) : null;
      if (selEl) selEl.addEventListener('change', () => {
        contactSide.selectedId = selEl.value || null;
        // Changing the contact (when it's the driving side) re-narrows cases.
        maybeCrossPopulateCasesFromContact();
      });
      const chg = E('naContactChange');
      if (chg) chg.addEventListener('click', (e) => { e.preventDefault(); revertToPickers(); });
      return;
    }
    if (contactSide.mode === 'pick') {
      host.innerHTML = `<label>Client</label><div id="naContactPick"></div>`;
      contactPicker = ContactPicker(E('naContactPick'), {
        placeholder: 'Search contacts…',
        onSelect: (cid, row) => {
          contactSide.selectedId = cid;
          contactSide.fixedLabel = `${cid} - ${(row && row.contact_name) || ('Contact ' + cid)}`;
          // Collapse this side to a confirmed line (with a change link).
          contactSide.mode = 'fixed';
          contactSide.drove = true;
          renderContactSide();
          maybeCrossPopulateCasesFromContact();
        },
      });
    }
  }

  // Render the CASE side into its host according to caseSide.mode.
  function renderCaseSide() {
    const host = E(caseSide.pickerHostId);
    if (!host) return;
    destroyCasePicker();
    host.innerHTML = '';

    if (caseSide.mode === 'none') return;

    if (caseSide.mode === 'fixed') {
      const chgLink = caseSide.drove
        ? ` <a href="#" id="naCaseChange" class="na-change">change</a>` : '';
      host.innerHTML = `<div class="na-fixed"><b>Case:</b> ${escAttr(caseSide.fixedLabel)}${chgLink}</div>`;
      const chg = E('naCaseChange');
      if (chg) chg.addEventListener('click', (e) => { e.preventDefault(); revertToPickers(); });
      return;
    }
    if (caseSide.mode === 'list') {
      const list = caseSide.list || [];
      const lockNote = caseSide.crossPopulated
        ? ` <a href="#" id="naCaseChange" class="na-change">change</a>` : '';
      let sel = `<select id="naCaseSel" style="width:300px;">`;
      if (caseSide.allowEmpty) sel += `<option value="" selected>— none —</option>`;
      list.forEach(c => {
        const typeLabel = fmtCaseType(c);
        const label = caseLabelOf(c) + (typeLabel ? `  ·  ${escAttr(typeLabel)}` : '');
        sel += `<option value="${c.case_id}">${label}</option>`;
      });
      sel += `</select>`;
      host.innerHTML = `<label>Case${caseSide.allowEmpty ? ' (optional)' : ''}</label>${sel}${lockNote}`;
      const selEl = E('naCaseSel');
      caseSide.selectedId = selEl ? (selEl.value || null) : null;
      if (selEl) selEl.addEventListener('change', () => {
        caseSide.selectedId = selEl.value || null;
      });
      const chg = E('naCaseChange');
      if (chg) chg.addEventListener('click', (e) => { e.preventDefault(); revertToPickers(); });
      return;
    }
    if (caseSide.mode === 'pick') {
      host.innerHTML = `<label>Case (optional)</label><div id="naCasePick"></div>`;
      casePicker = CasePicker(E('naCasePick'), {
        placeholder: 'Search cases…',
        onSelect: (cid, row) => {
          caseSide.selectedId = cid;
          caseSide.fixedLabel = caseLabelOf(row || { case_id: cid });
          // Collapse this side to a confirmed line (with a change link) so the
          // raw typed query no longer lingers in the input.
          caseSide.mode = 'fixed';
          caseSide.drove = true;
          renderCaseSide();
          maybeCrossPopulateContactsFromCase();
        },
      });
    }
  }

  // ── Revert both sides to their pickers (shell two-sided "change") ────────
  // Only affects sides that the user drove or that were cross-populated — a
  // caller-fixed or caller-list side (case / contact) is left untouched.
  function revertToPickers() {
    if (contactSide.drove || contactSide.crossPopulated) {
      contactSide.mode = 'pick';
      contactSide.drove = false;
      contactSide.crossPopulated = false;
      contactSide.selectedId = null;
      contactSide.list = null;
      renderContactSide();
    }
    if (caseSide.drove || caseSide.crossPopulated) {
      caseSide.mode = 'pick';
      caseSide.drove = false;
      caseSide.crossPopulated = false;
      caseSide.selectedId = null;
      caseSide.list = null;
      renderCaseSide();
    }
  }

  // ── Cross-population (shell two-sided behavior) ──────────────────────────
  // When the contact side resolves and the case side is a free picker OR an
  // already cross-populated list, (re)fetch that contact's cases and present
  // them as an optional select. Skip when the case side is caller-owned
  // (fixed / caller list / none).
  async function maybeCrossPopulateCasesFromContact() {
    if (caseSide.mode !== 'pick' && !caseSide.crossPopulated) return;
    const cid = contactSide.selectedId;
    if (!cid) return;
    try {
      const data = await P.apiSend(`/api/contacts/${cid}/cases`, 'GET');
      caseSide.list = (data && data.cases) || [];
      caseSide.allowEmpty = true;
      caseSide.crossPopulated = true;
      caseSide.drove = false;
      caseSide.mode = 'list';
      caseSide.selectedId = null;
      renderCaseSide();
    } catch (err) {
      // Soft-fail: leave the picker as-is.
      console.error('[newApptDialog] load contact cases failed:', err && err.message);
    }
  }

  // When the case side resolves and the contact side is a free picker OR an
  // already cross-populated list, (re)fetch that case's contacts and present
  // them as a required select defaulting to Primary. Skip when the contact
  // side is caller-owned (fixed / caller list).
  async function maybeCrossPopulateContactsFromCase() {
    if (contactSide.mode !== 'pick' && !contactSide.crossPopulated) return;
    const cid = caseSide.selectedId;
    if (!cid) return;
    try {
      const data = await P.apiSend(`/api/cases/${cid}/contacts`, 'GET');
      contactSide.list = (data && data.contacts) || [];
      contactSide.required = true;
      contactSide.defaultPrimary = true;
      contactSide.crossPopulated = true;
      contactSide.drove = false;
      contactSide.mode = 'list';
      contactSide.selectedId = null;
      renderContactSide();
    } catch (err) {
      console.error('[newApptDialog] load case contacts failed:', err && err.message);
    }
  }

  // ── Confirmation-message recompute (SMS/email auto-fill) ─────────────────
  function recompute() {
    const dt = E('naDate') ? E('naDate').value : '';
    const date = dt
      ? new Date(dt).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }).replace(',', ' at')
      : '';
    const hasCom = (E('naSMS') && E('naSMS').checked) || (E('naEmail') && E('naEmail').checked);
    if (E('naConfirmMsg')) {
      E('naConfirmMsg').style.display = hasCom ? '' : 'none';
      if (hasCom && dt) {
        const len  = E('naLen') ? E('naLen').value : '';
        const plat = (document.querySelector('input[name="naPlatform"]:checked') || {}).value || '';
        const type = E('naType') ? E('naType').value : '';
        E('naConfirmMsg').value = `This is to confirm that I scheduled you for a ${len} minute ${plat} ${type} on ${date}.  To view or change it: https://4lsg.com/m/{{appts.appt_manage_token|default:}}`;
      }
    }
  }

  // ── Slot picker (scheduler slice 4) ───────────────────────────────────────
  // Primary path: pick a date → fetch GET /api/availability for that single
  // day (provider = naWith, length = naLen, granularity 15, buffer 0,
  // min_notice 0 — staff deliberately book tighter than clients) → tap a slot.
  // Selecting a slot writes the same hidden #naDate datetime-local value the
  // dialog has always submitted, so recompute() and preConfirm() are
  // untouched. "Enter time manually" reveals #naDate and bypasses the picker
  // entirely — internal users may book over blocks/conflicts deliberately.
  const slotState = { seq: 0, timer: null, manual: false };

  function renderSlotMsg(msg) {
    const el = E('naSlotMsg');
    if (el) el.textContent = msg || '';
  }

  function renderSlots(starts) {
    const host = E('naSlots');
    if (!host) return;
    host.innerHTML = '';
    const cur = E('naDate') ? E('naDate').value : '';
    (starts || []).forEach((s) => {            // s = 'YYYY-MM-DD HH:mm' firm-local
      const iso = s.replace(' ', 'T');
      const btn = document.createElement('button');
      btn.type = 'button';                      // inside the <form> — never submit
      btn.className = 'na-slot' + (iso === cur ? ' na-slot-sel' : '');
      // Zone-less ISO parses as browser-local and prints browser-local, so the
      // wall-clock digits round-trip regardless of the viewer's timezone.
      btn.textContent = new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      btn.addEventListener('click', () => {
        if (E('naDate')) E('naDate').value = iso; // same underlying submit value
        host.querySelectorAll('.na-slot-sel').forEach(b => b.classList.remove('na-slot-sel'));
        btn.classList.add('na-slot-sel');
        recompute();
      });
      host.appendChild(btn);
    });
  }

  async function fetchSlots() {
    const date = E('naSlotDate') ? E('naSlotDate').value : '';
    const prov = E('naWith') ? E('naWith').value : '';
    const len  = E('naLen') ? parseInt(E('naLen').value, 10) : NaN;

    renderSlots([]);
    if (!date) { renderSlotMsg('Pick a date.'); return; }
    if (!prov) { renderSlotMsg('Pick who the appointment is with.'); return; }
    if (!Number.isInteger(len) || len < 1) {
      renderSlotMsg('Pick an appointment type (or enter a length) to see open slots.');
      return;
    }

    const seq = ++slotState.seq;
    renderSlotMsg('Loading open slots…');
    try {
      const data = await P.apiSend('/api/availability', 'GET', {
        providers: prov, length: len, from: date, to: date,
        granularity: 15, buffer: 0, min_notice: 0,
      });
      if (seq !== slotState.seq) return;        // superseded — don't clobber
      const starts = (data && data.slots && data.slots[prov]) || [];
      if (starts.length === 0) {
        renderSlots([]);
        renderSlotMsg('No open slots this day — "enter time manually" below to override.');
      } else {
        renderSlotMsg('');
        renderSlots(starts);
      }
    } catch (err) {
      if (seq !== slotState.seq) return;
      renderSlotMsg('Could not load slots: ' + ((err && err.message) || 'error'));
    }
  }

  function scheduleSlotFetch() {
    if (slotState.manual) return;
    clearTimeout(slotState.timer);
    slotState.timer = setTimeout(fetchSlots, 250);
  }

  function setManualMode(on) {
    slotState.manual = on;
    if (E('naSlotPicker'))   E('naSlotPicker').style.display = on ? 'none' : '';
    if (E('naDate'))         E('naDate').style.display       = on ? '' : 'none';
    if (E('naManualToggle')) E('naManualToggle').textContent = on ? 'use slot picker' : 'enter time manually';
    if (!on) scheduleSlotFetch();
  }

  Swal.fire({
    title: 'Schedule Appointment',
    customClass: { popup: 'yc-popup', htmlContainer: 'na-html' },
    html: `
      <div id="naContactHost" class="na-field"></div>
      <div id="naCaseHost" class="na-field"></div>
      <div class="na-section-label">With</div>
      <select id="naWith" style="width:300px;">${withOptions}</select><br>
      <form onchange="newApptDialog._recompute && newApptDialog._recompute()">
      <select id="naTypeSelect" style="width:300px"
        onchange="[E('naType').value,E('naLen').value]=this.value.split(',');E('naOtherSpan').style.display=this.value==','?'block':'none'">
        <option disabled selected>Appointment Type:</option>
        <option value="Strategy Session,15">Strategy Session (15 min)</option>
        <option value="Strategy Session Follow Up,15">Strategy Session Follow Up (15 min)</option>
        <option value="Strategy Session Follow Up,30">Strategy Session Follow Up (30 min)</option>
        <option value="Pre-filing Meeting,30">Pre-filing Meeting (30 min)</option>
        <option value="Schedules Completion Meeting,45">Schedules Completion Meeting (45 min)</option>
        <option value="Documents Completion Meeting,30">Documents Completion Meeting (30 min)</option>
        <option value="Matrix Completion Meeting,15">Matrix Completion Meeting (15 min)</option>
        <option value="Schedules Completion Meeting,20">Schedules Completion Meeting (20 min)</option>
        <option value=",">Other</option>
      </select><br>
      <span id="naOtherSpan" style="display:none">
        <input id="naType" style="width:240px" placeholder="Other Appointment Type">
        <input id="naLen" style="width:60px" maxlength="3" oninput="this.value=isNaN(this.value)?'':this.value" placeholder="length">
      </span><br>
      <label>Method: </label>
      <input style="width:auto" type="radio" id="naTel" name="naPlatform" value="telephone" checked>
      <label for="naTel">Telephone</label>
      <input style="width:auto" type="radio" id="naZoom" name="naPlatform" value="Zoom">
      <label for="naZoom">Zoom</label>
      <input style="width:auto" type="radio" id="naInPerson" name="naPlatform" value="in-person">
      <label for="naInPerson">In-person</label><br>
      <div id="naSlotPicker">
        <div class="na-slot-row">
          <label for="naSlotDate">Date:</label>
          <input type="date" id="naSlotDate" style="width:160px;">
        </div>
        <div id="naSlots" class="na-slots"></div>
        <div id="naSlotMsg" class="na-slot-msg"></div>
      </div>
      <a href="#" id="naManualToggle" class="na-manual-toggle">enter time manually</a><br>
      <input type="datetime-local" class="swal2-input" id="naDate" style="display:none;"><br>
      <textarea id="naNote" placeholder="Appointment Notes (optional)" style="height:60px;width:300px;"></textarea><br>
      <label>Confirmation Message?</label>
      <input style="width:auto" type="checkbox" id="naSMS"> <label for="naSMS">SMS</label>
      <input style="width:auto" type="checkbox" id="naEmail"> <label for="naEmail">Email</label><br>
      </form>
      <textarea id="naConfirmMsg" style="display:none;height:60px;width:300px;resize:none;"></textarea>
    `,
    showCancelButton: true,
    confirmButtonText: 'Schedule',
    showLoaderOnConfirm: true,
    allowOutsideClick: () => !Swal.isLoading(),

    didOpen: () => {
      newApptDialog._recompute = recompute;
      if (defaultWith && E('naWith')) E('naWith').value = defaultWith;
      if (opts.defaultDate && E('naDate')) E('naDate').value = opts.defaultDate;
      renderContactSide();
      renderCaseSide();
      recompute();

      // Slot picker wiring (scheduler slice 4)
      const toggle = E('naManualToggle');
      if (toggle) toggle.addEventListener('click', (e) => {
        e.preventDefault();
        setManualMode(!slotState.manual);
      });
      if (E('naSlotDate')) {
        // Default the picker date: defaultDate's date part, else today
        // (en-CA → YYYY-MM-DD in the browser's local zone).
        E('naSlotDate').value = opts.defaultDate
          ? String(opts.defaultDate).slice(0, 10)
          : new Date().toLocaleDateString('en-CA');
        E('naSlotDate').addEventListener('change', scheduleSlotFetch);
      }
      // Provider / type / custom-length changes re-query. The inline
      // onchange attributes (which write naType/naLen) run before these
      // listeners, so naLen is current when fetchSlots reads it.
      if (E('naWith'))       E('naWith').addEventListener('change', scheduleSlotFetch);
      if (E('naTypeSelect')) E('naTypeSelect').addEventListener('change', scheduleSlotFetch);
      if (E('naLen'))        E('naLen').addEventListener('input', scheduleSlotFetch);
      scheduleSlotFetch();
    },

    preConfirm: async () => {
      // Resolve contact (always required)
      const contactId = contactSide.selectedId;
      if (!contactId) {
        Swal.showValidationMessage('Pick a client for the appointment.');
        return false;
      }
      const apptWith = E('naWith') ? E('naWith').value : '';
      if (!apptWith) {
        Swal.showValidationMessage('Pick who the appointment is with.');
        return false;
      }
      const apptType = E('naType') ? E('naType').value : '';
      const apptLen  = E('naLen')  ? E('naLen').value  : '';
      const dtRaw    = E('naDate') ? E('naDate').value : '';
      const platform = (document.querySelector('input[name="naPlatform"]:checked') || {}).value || '';
      const note     = E('naNote') ? E('naNote').value : '';

      if (!apptType || !apptLen || !dtRaw) {
        Swal.showValidationMessage('Please complete all the mandatory fields.');
        return false;
      }
      const apptDate = dtRaw.replace('T', ' ') + ':00';
      if (whenDate(apptDate) === 'past') {
        Swal.showValidationMessage('Please choose a future date.');
        return false;
      }

      const body = {
        contact_id:    contactId,
        appt_type:     apptType,
        appt_length:   apptLen,
        appt_platform: platform,
        appt_date:     apptDate,
        appt_with:     apptWith,
        note,
        confirm_sms:     E('naSMS')   ? E('naSMS').checked   : false,
        confirm_email:   E('naEmail') ? E('naEmail').checked : false,
        confirm_message: E('naConfirmMsg') ? E('naConfirmMsg').value : '',
      };
      const useCaseId = caseSide.selectedId;
      if (useCaseId != null && useCaseId !== '') body.case_id = useCaseId;

      try {
        const data = await P.apiSend('/api/appts', 'POST', body);
        return { data };
      } catch (err) {
        Swal.showValidationMessage((err && err.message) || 'Failed to create appointment');
        return false;
      }
    },

    willClose: () => {
      destroyContactPicker();
      destroyCasePicker();
      clearTimeout(slotState.timer);
      slotState.seq++;                 // invalidate any in-flight fetch
      delete newApptDialog._recompute;
    },

  }).then((result) => {
    if (!result.isConfirmed || !result.value) return;
    const { data } = result.value;
    Toast.fire({
      icon:  data.status || 'success',
      title: data.title || (data.status === 'success' ? 'Success' : 'Error'),
      text:  data.message,
    });
    if (data.status === 'success' && typeof opts.onCreated === 'function') {
      opts.onCreated(data);
    }
  });
}


/* ──────────────────────────────────────────────────────────────────────────
   newEventDialog(opts)   (shared event creator / editor)

   One dialog for creating OR editing an "event" — a first-class dated
   case/contact obligation (confirmation hearing, docs deadline, internal
   milestone). DISTINCT from appts: an event links to ONE target — a case, OR
   a contact, OR nothing (internal). So there is a SINGLE optional link picker,
   NOT newApptDialog's two-sided cross-constrain.

   opts (all optional):
     // ── link target — pick ONE form: ──
     linkFixed: { type:'case'|'contact', id, label }
                  Locked link line (entity pages pass this). No picker shown.
     linkPick:  true
                  Shell mode: user chooses None / Case / Contact / Case #
                  (docket), then a CasePicker / ContactPicker is mounted —
                  Case # is a plain opaque text input (no picker, no shape
                  validation).
     (neither ⇒ treated as linkPick.)

     event:       <existing event row>   EDIT mode (prefill + PATCH). Omit = CREATE.
     defaultDate: 'YYYY-MM-DD'           prefill the date on create.
     onSaved:     fn(data)               after success (create OR edit).

   BOTH link options are CREATE-ONLY. In edit mode the link renders as a locked
   line and neither column is sent: an event's entity is fixed at creation
   (Slice 4 Phase B), and PATCHing either one is a 400. See the "CREATE ONLY"
   block in preConfirm.

   Reminder (verified editable via PATCH — the route threads body.reminder to
   updateEvent's { reminder } option): a reminder is offered in BOTH create and
   edit mode. In edit mode the existing reminder task is NOT shown (reminders
   are separate task rows); leaving the reminder user blank = reminders left
   untouched; choosing a user = (re)spawn one reminder task.

   Blocks calendar of (events.event_with): timed events block booking
   availability. Default "Everyone (firm-wide)" = event_with NULL = blocks
   every provider (historic behavior); picking a provider blocks only theirs;
   "Nobody" = event_with 0 = a timed event that carves no calendar at all
   (the engine's NULL-or-provider-id filters naturally exclude 0).
   All-day events never block availability — the field hides with the time
   row and is sent null, like event_length.
   ────────────────────────────────────────────────────────────────────────── */
function newEventDialog(opts = {}) {
  const isEdit = !!(opts.event && opts.event.event_id);
  const ev     = opts.event || {};

  // ── Date/time helpers (DB returns event_date as an ISO datetime string and
  //    event_time as 'HH:MM:SS' | null). Normalize for the inputs. ──────────
  const toDateInput = (d) => {
    if (!d) return '';
    const s = String(d);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : '';
  };
  const toTimeInput = (t) => {
    if (t == null || t === '') return '';
    const m = String(t).match(/(\d{2}:\d{2})/);
    return m ? m[1] : '';
  };

  // ── Link side ────────────────────────────────────────────────────────────
  // mode: 'fixed' (locked line) | 'pick' (None/Case/Contact chooser + picker)
  const link = {
    mode:        opts.linkFixed && opts.linkFixed.id != null ? 'fixed' : 'pick',
    fixedType:   opts.linkFixed ? opts.linkFixed.type : null,
    fixedId:     opts.linkFixed ? opts.linkFixed.id : null,
    fixedLabel:  opts.linkFixed ? (opts.linkFixed.label || `${opts.linkFixed.type} ${opts.linkFixed.id}`) : '',
    // 'pick' working state:
    kind:        'none',     // 'none' | 'case' | 'contact'  (the chosen link type)
    selId:       null,       // resolved id
    selLabel:    '',         // resolved label (for the confirmed line)
  };

  // EDIT prefill of the pick side from the existing event's link.
  if (!isEdit) {
    // create — nothing to prefill
  } else if (link.mode === 'pick') {
    if (ev.event_link_type === 'case' && ev.event_link_id != null) {
      link.kind = 'case';
      link.selId = String(ev.event_link_id);
      link.selLabel = ev.link_label || ev.case_number_display || String(ev.event_link_id);
    } else if (ev.event_link_type === 'contact' && ev.event_link_id != null) {
      link.kind = 'contact';
      link.selId = String(ev.event_link_id);
      link.selLabel = ev.link_label || ev.contact_name || `Contact #${ev.event_link_id}`;
    } else if (ev.event_link_type === 'case_number' && ev.event_link_id != null) {
      // Docket link — opaque free text, prefills the Case # input.
      link.kind = 'case_number';
      link.selId = String(ev.event_link_id);
      link.selLabel = String(ev.event_link_id);
    }
  }

  // ── Type select (single source — see getEventTypeOptions) ────────────────
  const TYPE_OPTIONS = getEventTypeOptions();
  const existingType = isEdit ? (ev.event_type || '') : '';
  const typeIsOther  = !!existingType && !TYPE_OPTIONS.includes(existingType);

  // ── firmData users for the reminder "to" select ──────────────────────────
  const firm = (typeof window !== 'undefined' && window.firmData)
    ? window.firmData
    : ((P && P.firmData) || {});
  const reminderUsers = (firm.users || []).slice().sort((a, b) => a.user - b.user);
  const reminderUserOptions = reminderUsers
    .map(u => `<option value="${u.user}">${escAttr(u.user_name)}</option>`)
    .join('');

  // ── "Blocks calendar of" (events.event_with) ─────────────────────────────
  // Scopes which provider's booking availability a timed event blocks:
  // '' → NULL = blocks EVERYONE (firm-wide — the historic default);
  // a does_appts user id = blocks only that provider. All-day events never
  // block availability, so the field lives inside neTimeWrap (hidden when
  // all-day) and is sent null for all-day events, same as event_length.
  const existingWith = isEdit && ev.event_with != null ? String(ev.event_with) : '';
  const blocksWithOptions = (firm.users || [])
    .filter(u => u.does_appts)
    .sort((a, b) => a.user - b.user)
    .map(u => `<option value="${u.user}"${String(u.user) === existingWith ? ' selected' : ''}>${escAttr(u.user_name)} only</option>`)
    .join('');

  // ── Active picker handle (destroy on close / on link-kind switch) ────────
  let picker = null;
  function destroyPicker() { if (picker) { picker.destroy(); picker = null; } }

  // EDIT MODE: the link is DISPLAY ONLY — see the "CREATE ONLY" block in
  // preConfirm for why. Derived straight off the event row so the locked line
  // reads the same whether or not the caller passed linkFixed.
  function editLinkLine() {
    const t = ev.event_link_type;
    if (t === 'case') {
      return { noun: 'Case',
               label: ev.link_label || ev.case_number_display || String(ev.event_link_id ?? '') };
    }
    if (t === 'contact') {
      return { noun: 'Contact',
               label: ev.link_label || ev.contact_name || ('Contact #' + ev.event_link_id) };
    }
    if (t === 'case_number') {
      // The docket, verbatim. Opaque free text — never parsed or validated.
      return { noun: 'Case #', label: String(ev.event_link_id ?? '') };
    }
    return { noun: 'Link', label: 'none (internal)' };
  }

  // Render the link area according to link.mode / link.kind.
  function renderLink() {
    const host = E('neLinkHost');
    if (!host) return;
    destroyPicker();
    host.innerHTML = '';

    // An event's entity is decided when it is created (Slice 4 Phase B). A
    // picker here would offer a change the server rejects with a 400, so edit
    // mode shows the current link locked.
    if (isEdit) {
      const L = editLinkLine();
      host.innerHTML = `<div class="na-fixed"><b>${L.noun}:</b> ${escAttr(L.label)}`
        + ` <span style="color:var(--text-muted);font-size:0.85em;">(set at creation)</span></div>`;
      return;
    }

    if (link.mode === 'fixed') {
      const noun = link.fixedType === 'case' ? 'Case' : 'Contact';
      host.innerHTML = `<div class="na-fixed"><b>${noun}:</b> ${escAttr(link.fixedLabel)}</div>`;
      return;
    }

    // pick mode: kind chooser + (confirmed line | picker)
    const chooser = `
      <label>Link to</label>
      <select id="neLinkKind">
        <option value="none"${link.kind === 'none' ? ' selected' : ''}>— none (internal) —</option>
        <option value="case"${link.kind === 'case' ? ' selected' : ''}>Case</option>
        <option value="contact"${link.kind === 'contact' ? ' selected' : ''}>Contact</option>
        <option value="case_number"${link.kind === 'case_number' ? ' selected' : ''}>Case #</option>
      </select>
      <div id="neLinkPickHost" style="margin-top:0.35em;"></div>`;
    host.innerHTML = chooser;

    const kindSel = E('neLinkKind');
    if (kindSel) kindSel.addEventListener('change', () => {
      link.kind = kindSel.value;
      link.selId = null;
      link.selLabel = '';
      renderLinkPick();
    });
    renderLinkPick();
  }

  // Render the picker / confirmed-line inside neLinkPickHost for the chosen kind.
  function renderLinkPick() {
    const ph = E('neLinkPickHost');
    if (!ph) return;
    destroyPicker();
    ph.innerHTML = '';

    if (link.kind === 'none') return;

    // Case # (docket): plain opaque text input — NO picker, NO shape
    // validation (equality-only matching server-side). Must precede the
    // confirmed-line block so an edit-prefilled docket renders as the input.
    if (link.kind === 'case_number') {
      ph.innerHTML = `<input id="neDocketInput" placeholder="24-46274-mlo"
        value="${escAttr(link.selId || '')}" style="width:100%;">`;
      const inp = E('neDocketInput');
      if (inp) inp.addEventListener('input', () => { link.selId = inp.value; });
      return;
    }

    // Already resolved → confirmed line + change link.
    if (link.selId != null) {
      const noun = link.kind === 'case' ? 'Case' : 'Contact';
      ph.innerHTML = `<div class="na-fixed"><b>${noun}:</b> ${escAttr(link.selLabel)}`
        + ` <a href="#" id="neLinkChange" class="na-change">change</a></div>`;
      const chg = E('neLinkChange');
      if (chg) chg.addEventListener('click', (e) => {
        e.preventDefault();
        link.selId = null;
        link.selLabel = '';
        renderLinkPick();
      });
      return;
    }

    // Mount the appropriate picker.
    const pickDiv = document.createElement('div');
    ph.appendChild(pickDiv);
    if (link.kind === 'case') {
      picker = CasePicker(pickDiv, {
        placeholder: 'Search cases…',
        onSelect: (cid, row) => {
          link.selId = String(cid);
          const numRaw = (row && (row.case_number_full || row.case_number)) || '';
          link.selLabel = (numRaw && numRaw !== cid) ? numRaw : `Case ${cid}`;
          renderLinkPick();
        },
      });
    } else if (link.kind === 'contact') {
      picker = ContactPicker(pickDiv, {
        placeholder: 'Search contacts…',
        onSelect: (cid, row) => {
          link.selId = String(cid);
          link.selLabel = `${cid} - ${(row && row.contact_name) || ('Contact ' + cid)}`;
          renderLinkPick();
        },
      });
    }
  }

  // ── All-day toggle: show/hide Time + Length ──────────────────────────────
  function applyAllDay() {
    const chk = E('neAllDay');
    const on  = chk ? chk.checked : false;
    const tw  = E('neTimeWrap');
    if (tw) tw.style.display = on ? 'none' : '';
  }

  // ── Type "Other" toggle ──────────────────────────────────────────────────
  function applyTypeOther() {
    const sel = E('neTypeSelect');
    const otherWrap = E('neTypeOtherWrap');
    if (!sel || !otherWrap) return;
    otherWrap.style.display = sel.value === '__other__' ? '' : 'none';
  }

  const initAllDay = isEdit
    ? (ev.event_all_day === 1 || ev.event_all_day === '1' || ev.event_all_day === true)
    : false;

  Swal.fire({
    title: isEdit ? 'Edit Event' : 'New Event',
    customClass: { popup: 'yc-popup', htmlContainer: 'na-html ne-html' },
    width: 560,
    html: `
      <div class="ne-form">
        <div class="ne-grid">
          <div class="ne-row ne-full">
            <label>Title</label>
            <input id="neTitle" placeholder="Event title"
                   value="${escAttr(isEdit ? (ev.event_title || '') : '')}">
          </div>

          <div class="ne-row">
            <label>Type</label>
            <select id="neTypeSelect"
                    onchange="newEventDialog._applyTypeOther && newEventDialog._applyTypeOther()">
              <option value=""${!existingType ? ' selected' : ''}>— select —</option>
              ${TYPE_OPTIONS.map(t =>
                `<option value="${escAttr(t)}"${(!typeIsOther && existingType === t) ? ' selected' : ''}>${escAttr(t)}</option>`
              ).join('')}
              <option value="__other__"${typeIsOther ? ' selected' : ''}>Other…</option>
            </select>
            <span id="neTypeOtherWrap" style="display:${typeIsOther ? '' : 'none'};margin-top:0.3em;">
              <input id="neTypeOther" placeholder="Custom type"
                     value="${escAttr(typeIsOther ? existingType : '')}">
            </span>
          </div>

          <div class="ne-row">
            <label>Date</label>
            <input id="neDate" type="date"
                   value="${toDateInput(isEdit ? ev.event_date : (opts.defaultDate || ''))}">
          </div>

          <div id="neLinkHost" class="ne-row ne-full"></div>

          <div class="ne-row ne-allday ne-full">
            <label>
              <input type="checkbox" id="neAllDay"
                     onchange="newEventDialog._applyAllDay && newEventDialog._applyAllDay()"${initAllDay ? ' checked' : ''}>
              All-day event
            </label>
          </div>

          <div id="neTimeWrap" class="ne-row ne-full" style="display:${initAllDay ? 'none' : ''};">
            <div class="ne-grid" style="gap:0.5em 0.8em;">
              <div class="ne-row">
                <label>Time</label>
                <input id="neTime" type="time"
                       value="${toTimeInput(isEdit ? ev.event_time : '')}">
              </div>
              <div class="ne-row">
                <label>Length (min, optional)</label>
                <input id="neLength" inputmode="numeric"
                       oninput="this.value=this.value.replace(/[^0-9]/g,'')"
                       placeholder="e.g. 60"
                       value="${escAttr(isEdit && ev.event_length != null ? ev.event_length : '')}">
              </div>
              <div class="ne-row ne-full">
                <label>Blocks calendar of</label>
                <select id="neBlocksWith">
                  <option value=""${!existingWith ? ' selected' : ''}>Everyone (firm-wide)</option>
                  <option value="0"${existingWith === '0' ? ' selected' : ''}>Nobody (doesn't block)</option>
                  ${blocksWithOptions}
                </select>
              </div>
            </div>
          </div>

          <div class="ne-row">
            <label>Location (optional)</label>
            <input id="neLocation"
                   value="${escAttr(isEdit ? (ev.event_location || '') : '')}">
          </div>

          <div class="ne-row">
            <label>Link / URL (optional)</label>
            <input id="neLink"
                   value="${escAttr(isEdit ? (ev.event_link || '') : '')}">
          </div>

          <div class="ne-row ne-full">
            <label>Note (optional)</label>
            <textarea id="neNote">${escAttr(isEdit ? (ev.event_note || '') : '')}</textarea>
          </div>

          <div class="ne-section">Reminder${isEdit ? ' — leave blank to keep existing' : ' (optional)'}</div>
          <div class="ne-row">
            <label>Remind</label>
            <select id="neRemindTo">
              <option value="">— no reminder —</option>
              ${reminderUserOptions}
            </select>
          </div>
          <div class="ne-row">
            <label>On date</label>
            <input id="neRemindDate" type="date">
          </div>
        </div>
      </div>
    `,
    showCancelButton: true,
    confirmButtonText: isEdit ? 'Save' : 'Create',
    showLoaderOnConfirm: true,
    allowOutsideClick: () => !Swal.isLoading(),

    didOpen: () => {
      newEventDialog._applyAllDay   = applyAllDay;
      newEventDialog._applyTypeOther = applyTypeOther;
      renderLink();
      applyTypeOther();
      applyAllDay();
    },

    preConfirm: async () => {
      const title = E('neTitle') ? E('neTitle').value.trim() : '';
      if (!title) { Swal.showValidationMessage('Title is required.'); return false; }

      // Type (select value, or the Other free-text)
      let type = '';
      const typeSel = E('neTypeSelect');
      if (typeSel) {
        type = typeSel.value === '__other__'
          ? (E('neTypeOther') ? E('neTypeOther').value.trim() : '')
          : typeSel.value;
      }

      const date = E('neDate') ? E('neDate').value : '';
      if (!date) { Swal.showValidationMessage('Date is required.'); return false; }

      const allDay = E('neAllDay') ? E('neAllDay').checked : false;
      let time = '';
      let length = '';
      let blocksWith = '';
      if (!allDay) {
        time = E('neTime') ? E('neTime').value : '';
        if (!time) { Swal.showValidationMessage('Time is required (or check All day).'); return false; }
        length = E('neLength') ? E('neLength').value.trim() : '';
        blocksWith = E('neBlocksWith') ? E('neBlocksWith').value : '';
      }

      const location = E('neLocation') ? E('neLocation').value.trim() : '';
      const urlLink  = E('neLink')     ? E('neLink').value.trim()     : '';
      const note     = E('neNote')     ? E('neNote').value            : '';

      // Reminder
      const remindTo   = E('neRemindTo')   ? E('neRemindTo').value   : '';
      const remindDate = E('neRemindDate') ? E('neRemindDate').value : '';
      if (remindTo && !remindDate) {
        Swal.showValidationMessage('Pick a reminder date (or clear the reminder user).');
        return false;
      }

      // Resolve link target. CREATE ONLY.
      //
      // Slice 4 Phase B removed event_link_type / event_link_id from
      // UPDATE_ALLOWED in services/eventService.js: a relink invalidates the
      // natural key findDuplicateEvent is built on, so PATCH now 400s with
      // "blocked fields: event_link_type, event_link_id" on either column.
      //
      // This dialog kept sending them on edit — via this block, or via an
      // `else if (isEdit)` fallback that set both to null to "allow clearing a
      // link on edit". One branch or the other always fired, so EVERY edit
      // save 400'd from the day Phase B shipped until 2026-08-20. Both are now
      // gated on create, and renderLink() shows the link locked in edit mode
      // so the UI stops offering a change the server will refuse.
      //
      // To move an event: cancel it and create it on the right entity.
      let linkType = null, linkId = null;
      if (isEdit) {
        // no-op — identity is creation-time
      } else if (link.mode === 'fixed') {
        linkType = link.fixedType;
        linkId   = String(link.fixedId);
      } else if (link.kind === 'case_number') {
        const inp = E('neDocketInput');
        const docket = String((inp ? inp.value : link.selId) || '').trim();
        if (!docket) {
          Swal.showValidationMessage('Enter a case # (docket), or choose "none".');
          return false;
        }
        linkType = 'case_number';
        linkId   = docket;   // opaque — sent verbatim (trimmed only)
      } else if (link.kind === 'case' || link.kind === 'contact') {
        if (!link.selId) {
          Swal.showValidationMessage(`Pick a ${link.kind} to link, or choose "none".`);
          return false;
        }
        linkType = link.kind;
        linkId   = String(link.selId);
      }

      const body = {
        event_title:    title,
        event_type:     type || null,
        event_date:     date,
        event_all_day:  allDay ? 1 : 0,
        event_time:     allDay ? null : time,
        event_length:   allDay ? null : (length !== '' ? Number(length) : null),
        event_with:     allDay ? null : (blocksWith !== '' ? Number(blocksWith) : null),
        event_location: location || null,
        event_link:     urlLink || null,
        event_note:     note || null,
      };
      // Unreachable on edit — linkType stays null there (see above).
      if (linkType) {
        body.event_link_type = linkType;
        body.event_link_id   = linkId;
      }
      if (remindTo) {
        body.reminder = { to: Number(remindTo), date: remindDate };
      }

      try {
        const data = isEdit
          ? await P.apiSend(`/api/events/${ev.event_id}`, 'PATCH', body)
          : await P.apiSend('/api/events', 'POST', body);
        return { data };
      } catch (err) {
        Swal.showValidationMessage((err && err.message) || 'Failed to save event');
        return false;
      }
    },

    willClose: () => {
      destroyPicker();
      delete newEventDialog._applyAllDay;
      delete newEventDialog._applyTypeOther;
    },

  }).then((result) => {
    if (!result.isConfirmed || !result.value) return;
    const { data } = result.value;
    Toast.fire({
      icon:  data.status || 'success',
      title: data.title || (data.status === 'success' ? 'Success' : 'Error'),
      text:  data.message,
    });
    if (data.status === 'success' && typeof opts.onSaved === 'function') {
      opts.onSaved(data);
    }
  });
}


/* ──────────────────────────────────────────────────────────────────────────
   eventComplete(id, onDone)  /  eventCancel(id, onDone)

   Shared row-action helpers (shell now, entity pages later). Each confirms,
   then PATCHes the status endpoint, Toasts the result, and on success calls
   onDone?.(). Mirror how apptUpdate is invoked from the tables (callback).
   ────────────────────────────────────────────────────────────────────────── */
function eventComplete(id, onDone) {
  Swal.fire({
    customClass: { popup: 'yc-popup' },
    title: 'Mark this event complete?',
    icon: 'question',
    showCancelButton: true,
    confirmButtonText: 'Mark complete',
    showLoaderOnConfirm: true,
    allowOutsideClick: () => !Swal.isLoading(),
    preConfirm: async () => {
      try {
        return { data: await P.apiSend(`/api/events/${id}/complete`, 'PATCH') };
      } catch (err) {
        Swal.showValidationMessage((err && err.message) || 'Failed to complete event');
        return false;
      }
    },
  }).then((result) => {
    if (!result.isConfirmed || !result.value) return;
    const { data } = result.value;
    Toast.fire({ icon: data.status || 'success', title: data.title || 'Done!', text: data.message });
    if (data.status === 'success' && typeof onDone === 'function') onDone();
  });
}

function eventCancel(id, onDone) {
  Swal.fire({
    customClass: { popup: 'yc-popup' },
    title: 'Cancel this event?',
    text: 'This also removes it from the calendar.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Cancel event',
    cancelButtonText: 'Keep',
    showLoaderOnConfirm: true,
    allowOutsideClick: () => !Swal.isLoading(),
    preConfirm: async () => {
      try {
        return { data: await P.apiSend(`/api/events/${id}/cancel`, 'PATCH', { delete_gcal: true }) };
      } catch (err) {
        Swal.showValidationMessage((err && err.message) || 'Failed to cancel event');
        return false;
      }
    },
  }).then((result) => {
    if (!result.isConfirmed || !result.value) return;
    const { data } = result.value;
    Toast.fire({ icon: data.status || 'success', title: data.title || 'Canceled', text: data.message });
    if (data.status === 'success' && typeof onDone === 'function') onDone();
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
   NewCaseForm(prefill, onSuccess)  (Phase 4.2 — orphan-case create-new)

   Create a brand-new case from scratch, optionally pre-filled with a docket
   carried over from CaseAdoptDialog's create-new branch. Structural sibling of
   newContact's create path: it POSTs to the SAME known-good intake endpoint
   (/api/intake/case) rather than writing a parallel INSERT — that endpoint is
   the only path that correctly satisfies the cases table's ~45 mostly-NOT-NULL
   columns (via implicit defaults under non-strict sql_mode) and inserts the
   Primary case_relate row.

   prefill (all keys optional):
     case_number          string  → #ncf-num   (opaque, editable)
     case_number_full     string  → #ncf-full  (opaque, editable)
     primary_contact_id   number  → pre-select the ContactPicker
     primary_contact_name string  → display label for the pre-selected contact
     suppressOpen         bool    → if true, do NOT auto-open the new case file

   Docket values are displayed as-is. NewCaseForm does NOT re-split — the caller
   (CaseAdoptDialog) already applied splitDocket. case_number / case_number_full
   stay OPAQUE here too: no shape parsing, client or server.

   onSuccess(data) receives the raw /api/intake/case response
   ({ status, action:'created', id, case_relate }).

   Required to submit: a primary contact selected AND a non-empty case_type.
   Docket fields are both optional. On 409 (collision) → validation message,
   dialog stays open (no force path — collisions hard-block, matching the
   adopt dialog).

   Success/open behavior mirrors newContact: default opens the new case file
   via the resolved addFile, UNLESS prefill.suppressOpen is set.
   ────────────────────────────────────────────────────────────────────────── */
function NewCaseForm(prefill = {}, onSuccess = null) {
  let picker = null;
  let selectedContactId = (prefill.primary_contact_id != null)
    ? prefill.primary_contact_id
    : null;

  // Type select is map-driven (fe-case_types via getCaseTypeMap). The 'Other'
  // free-text override is preserved: selecting 'Other' reveals an input that,
  // when non-empty, replaces case_type (types stay opaque free text). Subtype
  // select cascades from the chosen type; hidden when the type has none.
  const typeMap = getCaseTypeMap();
  const typeKeys = Object.keys(typeMap);
  const typeOptions = typeKeys
    .map((t, i) => `<option${i === 0 ? ' selected' : ''}>${escAttr(t)}</option>`)
    .join('');

  const prefName = prefill.primary_contact_name
    ? escAttr(prefill.primary_contact_name)
    : '';

  Swal.fire({
    title: 'Create new case',
    html: `
      <div class="ncf-section-label">Primary contact</div>
      <div class="ncf-field"><div id="ncf-picker-mount"></div></div>
      <div id="ncf-dup-warn" style="display:none;margin:8px 0;padding:8px;border:1px solid var(--warn);background:var(--warn-soft);color:var(--warn);border-radius:6px;text-align:left;font-size:0.88em"></div>

      <div class="ncf-field">
        <label for="ncf-type">Case type</label>
        <select id="ncf-type">
          ${typeOptions}
        </select>
      </div>
      <div class="ncf-field" id="ncf-subtype-wrap" style="display:none;">
        <label for="ncf-subtype">Subtype</label>
        <select id="ncf-subtype"></select>
      </div>
      <div class="ncf-field">
        <input type="text" id="ncf-other-type" placeholder="Enter case type" style="display:none;">
      </div>

      <div class="ncf-section-label">Docket (optional)</div>
      <div class="ncf-docket-row">
        <div class="ncf-field">
          <label for="ncf-num">Case number</label>
          <input type="text" id="ncf-num" value="${escAttr(prefill.case_number || '')}">
        </div>
        <div class="ncf-field">
          <label for="ncf-full">Case number (full)</label>
          <input type="text" id="ncf-full" value="${escAttr(prefill.case_number_full || '')}">
        </div>
      </div>
    `,
    showCancelButton: true,
    showConfirmButton: true,
    confirmButtonText: 'Create case',
    cancelButtonText: 'Cancel',
    showCloseButton: true,
    showLoaderOnConfirm: true,
    customClass: { popup: 'yc-popup', htmlContainer: 'ncf-html' },
    allowOutsideClick: () => !Swal.isLoading(),

    didOpen: () => {
      const confirmBtn = Swal.getConfirmButton();
      // Enable confirm only once a contact is selected. If we have a prefill
      // contact, start enabled and seed the picker's input with the name.
      if (confirmBtn) confirmBtn.disabled = (selectedContactId == null);

      // Cascading subtype: repopulate from the map on every type change.
      // Blank first option = "no subtype" (subtype is always optional).
      // 'Other' additionally reveals the free-text type override.
      const syncNcfType = () => {
        const t = E('ncf-type').value;
        const subs = typeMap[t] || [];
        const subSel = E('ncf-subtype');
        subSel.innerHTML = `<option value="" selected>—</option>`
          + subs.map(s => `<option>${escAttr(s)}</option>`).join('');
        E('ncf-subtype-wrap').style.display = subs.length ? '' : 'none';
        E('ncf-other-type').style.display = (t === 'Other') ? '' : 'none';
        ncfCheckDupes();
      };

      /* Duplicate-open-case warning (2026-08 — merge prevention).
         The lead+filed duplicate pattern exists because a second case gets
         created beside a client's existing open case instead of the docket
         being adopted onto it. Non-blocking: warn with the list of the
         contact's non-Closed/Concluded cases of the SAME type so the user
         can bail out and use the adopt flow (or knowingly proceed —
         adversary proceedings etc. are legitimate second cases).
         Fires on contact select and on type change; results cached per
         contact so re-toggling type doesn't refetch. */
      let ncfDupeCache = { cid: null, cases: [] };
      async function ncfCheckDupes() {
        const warn = E('ncf-dup-warn');
        if (!warn) return;
        if (selectedContactId == null) { warn.style.display = 'none'; return; }
        try {
          if (ncfDupeCache.cid !== selectedContactId) {
            const r = await P.apiSend(`/api/contacts/${selectedContactId}/cases`, 'GET');
            ncfDupeCache = { cid: selectedContactId, cases: r.cases || [] };
          }
        } catch { warn.style.display = 'none'; return; }
        const typeRaw = E('ncf-type').value;
        const otherTxt = (E('ncf-other-type') && E('ncf-other-type').value || '').trim();
        const curType = (typeRaw === 'Other' && otherTxt) ? otherTxt : typeRaw;
        const open = ncfDupeCache.cases.filter(c =>
          c.case_type === curType && !['Closed', 'Concluded'].includes(c.case_stage));
        if (!open.length) { warn.style.display = 'none'; return; }
        const list = open.map(c => {
          const num = c.case_number_full || c.case_number || c.case_id;
          return `<b>${escAttr(num)}</b> (${escAttr(c.case_stage)})`;
        }).join(', ');
        const hasDocketInput =
          ((E('ncf-num') && E('ncf-num').value) || (E('ncf-full') && E('ncf-full').value) || '').trim() !== '';
        const docketlessOpen = open.some(c => !c.case_number && !c.case_number_full);
        warn.innerHTML =
          `&#9888; This contact already has ${open.length} open ${escAttr(curType)} `
          + `case${open.length > 1 ? 's' : ''}: ${list}.`
          + ((hasDocketInput && docketlessOpen)
              ? ' If this docket belongs to one of them, cancel and adopt the docket onto that case instead of creating a duplicate.'
              : ' Only continue if this is genuinely a new, separate case.');
        warn.style.display = '';
      }
      E('ncf-type').addEventListener('change', syncNcfType);
      syncNcfType();

      picker = ContactPicker(E('ncf-picker-mount'), {
        placeholder: 'Search contacts…',
        initialQuery: prefName && (selectedContactId == null) ? prefName : '',
        onSelect: (cid) => {
          selectedContactId = cid;
          if (confirmBtn) confirmBtn.disabled = false;
          ncfCheckDupes();
        },
      });

      // If a primary contact was pre-supplied, show its name in the input so
      // the user sees who's attached without re-searching. They can still type
      // to change it (which re-runs the search and re-selects on click).
      if (selectedContactId != null && prefName) {
        const inp = E('ncf-picker-mount') && E('ncf-picker-mount').querySelector('.cp-input');
        if (inp) inp.value = prefill.primary_contact_name;
      }
    },

    preConfirm: async () => {
      // Validate: a primary contact and a non-empty case_type.
      if (selectedContactId == null) {
        Swal.showValidationMessage('Pick a primary contact for the case.');
        return false;
      }
      const typeRaw = E('ncf-type').value;
      // 'Other' + non-empty free text = custom opaque type. Empty free text
      // falls back to the literal 'Other' (it's a real category now).
      const otherTxt = (E('ncf-other-type') && E('ncf-other-type').value || '').trim();
      const caseType = (typeRaw === 'Other' && otherTxt) ? otherTxt : typeRaw;
      if (!caseType) {
        Swal.showValidationMessage('Select a case type.');
        return false;
      }
      // Subtype select only carries a value when the chosen type has subtypes
      // (it's repopulated blank-first on every type change), so a stale value
      // can't leak across types.
      const caseSubtype = (E('ncf-subtype') && E('ncf-subtype').value || '').trim();

      // Docket fields — opaque, optional. Trim; empty → null (match intake's
      // empty→null handling). No shape parsing.
      const num  = (E('ncf-num')  && E('ncf-num').value  || '').trim();
      const full = (E('ncf-full') && E('ncf-full').value || '').trim();

      const body = {
        contact_id: selectedContactId,
        case_type:  caseType,
        // The subtype select was read but never SENT (pre-T8 bug): every case
        // created here landed with case_subtype NULL. Empty → omit, so a type
        // with no subtypes sends exactly what it used to.
        ...(caseSubtype ? { case_subtype: caseSubtype } : {}),
        case_number:      num  || null,
        case_number_full: full || null,
      };

      try {
        const data = await P.apiSend('/api/intake/case', 'POST', body);
        return { data };
      } catch (err) {
        // apiSend throws ApiError with err.status + err.body (parsed JSON).
        // 409 = docket collision → surface the server message, stay open.
        const msg = (err && err.body && err.body.message) || err.message || 'Failed to create case';
        Swal.showValidationMessage(msg);
        return false;
      }
    },

    willClose: () => {
      if (picker) picker.destroy();
    },

  }).then((result) => {
    if (!result.isConfirmed || !result.value) return; // cancelled / closed
    const { data } = result.value;

    Toast.fire({
      icon: data.status === 'success' ? 'success' : 'error',
      title: data.status === 'success' ? 'Case created' : 'Error',
      text: data.message,
    });

    if (data.status === 'success') {
      if (!prefill.suppressOpen) {
        const openFile = _resolveAddFile();
        if (openFile) openFile(data.id, 'case', data.id);
      }
      if (typeof onSuccess === 'function') onSuccess(data);
    }
  });
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
      <div class="cad-create-row">
        <button type="button" id="cadCreateNew" class="cad-create-btn"><i class="fa-solid fa-folder-plus"></i>&nbsp;Create new case with this docket</button>
      </div>
      <div id="cad-preview" class="cad-preview"></div>
    `,
    showCancelButton: true,
    showConfirmButton: true,
    confirmButtonText: 'Adopt',
    cancelButtonText: 'Cancel',
    showCloseButton: true,
    customClass: { popup: 'yc-popup', htmlContainer: 'cad-html' },
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

      // Create-new branch: close this dialog and hand off to NewCaseForm,
      // carrying the CURRENT field values (the user may have edited the
      // splitDocket pre-fill, or cleared one field for a partial docket).
      // The picked case (if any) is irrelevant here — create always makes a
      // NEW case — so we don't pass it. NewCaseForm opens the new case file on
      // success (default behavior); onDone re-renders the log so the
      // formerly-orphan rows now resolve to the new case.
      const createBtn = E('cadCreateNew');
      if (createBtn) {
        createBtn.addEventListener('click', () => {
          const { num, full } = currentDocketVals();
          if (previewTimer) clearTimeout(previewTimer);
          if (picker) picker.destroy();
          Swal.close();
          NewCaseForm(
            { case_number: num || null, case_number_full: full || null },
            (data) => {
              if (typeof onDone === 'function') {
                onDone({ action: 'created', case_id: data.id });
              }
            }
          );
        });
      }
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
        On 400 with body.same_contact (the chosen contact ALREADY holds the
        value as an active row, its start_date just doesn't reach the log) →
        offer to backdate that row's start_date to the chosen date via
        PATCH /api/contact-{phones|emails}/:id instead of stacking a
        duplicate row. If the existing row already covers the chosen date,
        nothing to write — the feed row was stale; re-render via onDone.
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
    customClass: { popup: 'yc-popup', htmlContainer: 'oad-html' },

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
    // response.conflict on a 409, and the same-contact marker as
    // response.same_contact on a 400.

    // ── Same-contact collision: the chosen contact already holds this
    // value as an active row — the only thing to fix is the window.
    // Offer to pull the row's start_date back to the chosen date.
    const sameContact = (err && err.body && err.body.same_contact) || null;
    if (sameContact) {
      const rowStart    = sameContact.start_date || null;
      const recipient   = selected.contact_name || ('contact ' + selected.contact_id);
      if (rowStart == null || rowStart <= chosenStartDate) {
        // The existing row already covers the chosen date — the orphan
        // row in the feed was stale. Nothing to write; re-render.
        Toast.fire({ icon: 'info', title: 'Already attached',
                     text: `${recipient} already holds this ${type} for that date.` });
        if (typeof onDone === 'function') {
          onDone({ action: 'attached', contact_id: selected.contact_id, force_used: false });
        }
        return;
      }
      const confirmBackdate = await Swal.fire({
        customClass: { popup: 'yc-popup' },
        title: 'Already on this contact',
        html: `<b>${escAttr(recipient)}</b> already has this ${isPhone ? 'phone' : 'email'}, ` +
              `starting <b>${escAttr(rowStart)}</b>.<br>` +
              `Move the start date back to <b>${escAttr(chosenStartDate)}</b>?`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonText: 'Move start date',
        cancelButtonText: 'Cancel',
      });
      if (!confirmBackdate.isConfirmed) return;
      try {
        await P.apiSend(`${endpoint}/${sameContact.id}`, 'PATCH',
                        { start_date: chosenStartDate });
      } catch (err2) {
        // e.g. the overlap guard: a prior holder's window blocks the
        // backdate — the message names the boundary date to use.
        Toast.fire({ icon: 'error', title: 'Start-date update failed', text: err2.message || '' });
        return;
      }
      Toast.fire({ icon: 'success', title: 'Start date updated' });
      if (typeof onDone === 'function') {
        onDone({ action: 'attached', contact_id: selected.contact_id, force_used: false });
      }
      return;
    }

    const conflict = (err && err.body && err.body.conflict) || null;
    const isConflict = (err && err.status === 409) || !!conflict;
    if (!isConflict) {
      Toast.fire({ icon: 'error', title: 'Attach failed', text: err.message || '' });
      return;
    }

    const donorName = (conflict && conflict.contact_name) ? conflict.contact_name : 'another contact';
    const recipientName = selected.contact_name || ('contact ' + selected.contact_id);
    const confirmForce = await Swal.fire({
      customClass: { popup: 'yc-popup' },
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


/* ── LogAboutDialog (About-link S3) ──────────────────────────────────────────
   Set / change / remove the SECONDARY "what it's about" attribution
   (log_about_type / log_about_id) on a log row. Backed by
   PUT /api/log/:id/about; never touches the primary identity link.

   Fetches the row fresh via GET /api/log/:id rather than trusting the feed's
   copy (showLogDetails precedent) — the badge may be stale if another tab
   changed the link.

   UI scope is deliberately case | contact only. The API accepts the full
   8-type enum; the other six are automation/API territory and get no picker.
   A pre-existing about of another type still displays in the "currently
   linked" line and can be removed or replaced here.

   SWAL single-instance rule (AssetPicker precedent): no nested Swal while
   open. Remove is a deny-button, writes happen in preConfirm/preDeny with
   Swal.showValidationMessage on failure, Toasts fire only after close.

   Sync: DELIBERATELY SILENT on the bus (review fix S3-1). An about-link
   write changes a LOG row, not a cases/contacts column — but every current
   `case:X` / `contact:X` yc_refetch subscriber refetches ENTITY data (full
   case GET, cases-list reload, Kanban reload), so an emit here would wake
   three unrelated surfaces to guaranteed no-ops while the one surface that
   did change (the log feed) has no subscription. The local feed refreshes
   via onDone. When log feeds grow a bus subscription, add the emit WITH the
   reader, not before it. */
async function LogAboutDialog(logId, onDone = null) {
  let entry;
  try {
    const r = await P.apiSend('/api/log/' + encodeURIComponent(logId), 'GET');
    entry = (r && (r.data || r.entry)) || null;
  } catch (err) {
    Toast.fire({ icon: 'error', title: 'Could not load log row', text: err.message });
    return;
  }
  if (!entry) { Toast.fire({ icon: 'error', title: 'Log row not found' }); return; }

  const cur = entry.log_about_type
    ? { type: String(entry.log_about_type), id: String(entry.log_about_id) }
    : null;

  let picker = null;      // active Case/Contact picker instance
  let sel    = null;      // { type, id, label } — the user's pick

  function setChosen() {
    const el = E('lab-chosen');
    if (!el) return;
    el.textContent = sel ? ('Selected: ' + sel.label) : '';
  }

  function mountPicker(kind) {
    const host = E('lab-picker');
    if (!host) return;
    if (picker && typeof picker.destroy === 'function') picker.destroy();
    sel = null;
    setChosen();
    if (kind === 'contact') {
      picker = ContactPicker(host, {
        placeholder: 'Search contacts\u2026',
        onSelect: (id, row) => {
          sel = { type: 'contact', id: String(id),
                  label: (row && row.contact_name) || ('Contact ' + id) };
          setChosen();
        }
      });
    } else {
      picker = CasePicker(host, {
        placeholder: 'Search cases\u2026',
        onSelect: (id, row) => {
          const r = row || {};
          sel = { type: 'case', id: String(id),
                  label: r.case_number_full || r.case_number || String(id) };
          setChosen();
        }
      });
    }
    if (typeof picker.focus === 'function') picker.focus();
  }

  const result = await Swal.fire({
    customClass: { popup: 'yc-popup', htmlContainer: 'lab-html' },
    title: 'Link log entry',
    html: `
      <div style="text-align:left">
        <div id="lab-current" class="lab-current"></div>
        <div class="lab-kind-row">
          <label><input type="radio" name="lab-kind" value="case" checked> Case</label>
          <label><input type="radio" name="lab-kind" value="contact"> Contact</label>
        </div>
        <div id="lab-picker"></div>
        <div id="lab-chosen" class="lab-chosen"></div>
      </div>
    `,
    showCancelButton: true,
    showDenyButton: !!cur,
    confirmButtonText: 'Link',
    denyButtonText: 'Remove link',
    cancelButtonText: 'Cancel',
    focusConfirm: false,
    didOpen: () => {
      // "Currently linked" line — textContent only; the label can carry an
      // attacker-supplied about_id (set via raw API).
      if (cur) {
        const el = E('lab-current');
        let label;
        if (cur.type === 'case') {
          label = 'case ' + (entry.about_case_number || cur.id);
        } else if (cur.type === 'contact') {
          label = 'contact ' + (entry.about_contact_name || cur.id);
        } else {
          label = cur.type + ' ' + cur.id;
        }
        el.textContent = 'Currently linked to ' + label + '.';
      }
      document.querySelectorAll('input[name="lab-kind"]').forEach((r) => {
        r.addEventListener('change', () => mountPicker(r.value));
      });
      mountPicker('case');
    },
    preConfirm: async () => {
      if (!sel) { Swal.showValidationMessage('Pick a case or contact first'); return false; }
      try {
        await P.apiSend('/api/log/' + encodeURIComponent(logId) + '/about', 'PUT',
                        { about_type: sel.type, about_id: sel.id });
        return { action: 'set' };
      } catch (err) {
        Swal.showValidationMessage('Link failed: ' + err.message);
        return false;
      }
    },
    preDeny: async () => {
      try {
        await P.apiSend('/api/log/' + encodeURIComponent(logId) + '/about', 'PUT',
                        { about_type: 'none' });
        return { action: 'removed' };
      } catch (err) {
        Swal.showValidationMessage('Remove failed: ' + err.message);
        return false;
      }
    },
  });

  if (picker && typeof picker.destroy === 'function') picker.destroy();

  if (result.isConfirmed && result.value) {
    Toast.fire({ icon: 'success', title: 'Linked' });
    if (onDone) onDone();
  } else if (result.isDenied && result.value) {
    Toast.fire({ icon: 'success', title: 'Link removed' });
    if (onDone) onDone();
  }
}
