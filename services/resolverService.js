// services/resolverService.js
//
// Universal placeholder resolver.
// Resolves {{table.column|modifier}} placeholders against live DB data.
// Fetches all referenced tables in a single JOIN query.
//
// Usage:
//   const { resolve } = require('./resolverService');
//   const result = await resolve({
//     db,
//     text: "Hi {{contacts.contact_fname}}, your appt is {{appts.appt_date|date:dddd MMMM Do}}",
//     refs: {
//       contacts: { contact_id: 1001 },
//       appts:    { appt_id: 456 }
//     },
//     strict: false
//   });
//
// Placeholder syntax:
//   {{table.column}}
//   {{table.column|modifier}}
//   {{table.column|default:fallback text}}
//   {{table.column|default:{{other.column}}|upper}}
//
// Modifiers (applied left-to-right):
//   default:VALUE or default:{{table.col}}
//   date:FORMAT / time:FORMAT / datetime:FORMAT
//   phone           → (123) 456-7890
//   email_mask      → t***@e*****.com
//   upper/uppercase, lower/lowercase, cap/capitalize
//
// FORMAT TOKENS: YYYY MM MMMM MMM DD D Do DoW dddd ddd HH hh h mm ss A

// ─────────────────────────────────────────────────────────────
// Security config
// ─────────────────────────────────────────────────────────────

const ALLOWED_TABLES = [
  'contacts',
  'cases',
  'appts',
  'tasks',
  'log',
  'users',
  'phone_lines',
  'scheduled_jobs',
  'workflows',
  'workflow_executions',
  'sequence_enrollments',
  'sequence_templates',
];

const BLOCKED_COLUMNS = {
  contacts: ['contact_ssn'],
  users:    ['password', 'password_hash'],
};

// ─────────────────────────────────────────────────────────────
// Placeholder scanner — depth-counting character scanner
// Handles nested {{...}} correctly, which regex cannot.
// ─────────────────────────────────────────────────────────────

/**
 * Find all top-level {{...}} placeholders in text.
 * Returns array of { match: string, start: number, end: number }
 */
function findPlaceholders(text) {
  const results = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{' && text[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '{' && text[j + 1] === '{')       { depth++; j += 2; }
        else if (text[j] === '}' && text[j + 1] === '}') { depth--; j += 2; }
        else j++;
      }
      if (depth === 0) {
        results.push({ match: text.slice(i, j), start: i, end: j });
        i = j;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return results;
}

/**
 * Replace all top-level placeholders in text using a resolver function.
 * Leaves unresolved placeholders in place (returns the original match string).
 */
function replacePlaceholders(text, resolveFn) {
  let result = '';
  let lastEnd = 0;
  for (const { match, start, end } of findPlaceholders(text)) {
    result += text.slice(lastEnd, start);
    const resolved = resolveFn(match);
    result += resolved !== null ? resolved : match;
    lastEnd = end;
  }
  result += text.slice(lastEnd);
  return result;
}

// ─────────────────────────────────────────────────────────────
// Split modifier parts — handles nested braces in defaults
// ─────────────────────────────────────────────────────────────

function splitParts(content) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (const ch of content) {
    if (ch === '|' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// ─────────────────────────────────────────────────────────────
// Date formatter — marker-based to prevent token re-substitution
// e.g. 'h' (hour) must not replace the 'h' inside already-resolved "March"
// ─────────────────────────────────────────────────────────────

const pad = n => String(n).padStart(2, '0');

const ORDINAL_WORDS = [
  'First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth','Ninth','Tenth',
  'Eleventh','Twelfth','Thirteenth','Fourteenth','Fifteenth','Sixteenth','Seventeenth',
  'Eighteenth','Nineteenth','Twentieth','Twenty-first','Twenty-second','Twenty-third',
  'Twenty-fourth','Twenty-fifth','Twenty-sixth','Twenty-seventh','Twenty-eighth',
  'Twenty-ninth','Thirtieth','Thirty-first'
];

const ordinal = n => {
  if (n % 100 >= 11 && n % 100 <= 13) return n + 'th';
  switch (n % 10) {
    case 1: return n + 'st';
    case 2: return n + 'nd';
    case 3: return n + 'rd';
    default: return n + 'th';
  }
};

const WEEKDAYS      = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const WEEKDAYS_ABBR = ['Sun','Mon','Tues','Wed','Thurs','Fri','Sat'];
const MONTHS        = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_ABBR   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];

function formatDate(value, format) {
  const d = new Date(value);
  if (isNaN(d)) return null;

  const tokens = {
    YYYY:  String(d.getFullYear()),
    MMMM:  MONTHS[d.getMonth()],
    MMM:   MONTHS_ABBR[d.getMonth()],
    MM:    pad(d.getMonth() + 1),
    DoW:   ORDINAL_WORDS[d.getDate() - 1] || String(d.getDate()),
    Do:    ordinal(d.getDate()),
    DD:    pad(d.getDate()),
    D:     String(d.getDate()),
    dddd:  WEEKDAYS[d.getDay()],
    ddd:   WEEKDAYS_ABBR[d.getDay()],
    HH:    pad(d.getHours()),
    hh:    pad(d.getHours() % 12 || 12),
    h:     String(d.getHours() % 12 || 12),
    mm:    pad(d.getMinutes()),
    ss:    pad(d.getSeconds()),
    A:     d.getHours() >= 12 ? 'PM' : 'AM',
  };

  // Phase 1: replace each token with a unique null-char marker.
  // Sorted longest-first so MMMM is matched before MM, Do before D, etc.
  // Using null chars (\x00) as delimiters guarantees no collision with
  // user text or token values.
  const markers = {};
  let out = format;
  Object.keys(tokens)
    .sort((a, b) => b.length - a.length)
    .forEach((token, i) => {
      const marker = `\x00${i}\x00`;
      out = out.split(token).join(marker);
      markers[marker] = tokens[token];
    });

  // Phase 2: replace markers with their values
  for (const [marker, val] of Object.entries(markers)) {
    out = out.split(marker).join(val);
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Other modifiers
// ─────────────────────────────────────────────────────────────

function formatPhone(value) {
  if (!value) return value;
  const d = String(value).replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 7)  return `${d.slice(0,3)}-${d.slice(3)}`;
  return value;
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return email;
  const [local, domain] = email.split('@');
  const parts = domain.split('.');
  const tld   = parts.pop();
  const dn    = parts.join('.');

  const maskStr = (s) =>
    s.length <= 1 ? s :
    s.length === 2 ? s[0] + '*' :
    s[0] + '*'.repeat(s.length - 2) + s.at(-1);

  return `${maskStr(local)}@${maskStr(dn)}.${tld}`;
}

function applyTextTransform(value, mod) {
  if (typeof value !== 'string') return value;
  switch (mod) {
    case 'upper': case 'uppercase': return value.toUpperCase();
    case 'lower': case 'lowercase': return value.toLowerCase();
    case 'cap':   case 'capitalize':
      return value.toLowerCase().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    default: return value;
  }
}

// ─────────────────────────────────────────────────────────────
// Core resolver
// ─────────────────────────────────────────────────────────────

async function resolve({ db, text, refs = {}, strict = false }) {
  if (!text || typeof text !== 'string') {
    return { status: 'success', text: text ?? '', unresolved: [] };
  }

  // ── Step 1: Scan all placeholders to find which tables/columns are needed ──

  const tableColumns = new Map(); // Map<table, Set<column>>
  const scanErrors   = [];

  // unknownTables: tables referenced in placeholders but not in ALLOWED_TABLES.
  // These are treated as soft unresolved (not hard errors) so the rest can still resolve.
  const unknownTables = new Set();

  const scanContent = (content, depth = 0) => {
    if (depth > 20) return;
    const parts = splitParts(content);
    if (!parts.length) return;

    const entityField = parts[0];
    const dotIdx      = entityField.indexOf('.');
    if (dotIdx === -1) return;

    const tableName  = entityField.slice(0, dotIdx).trim();
    const columnName = entityField.slice(dotIdx + 1).trim();

    if (!ALLOWED_TABLES.includes(tableName)) {
      // Soft: mark as unknown — placeholder will remain unresolved
      unknownTables.add(tableName);
      return;
    }

    const blocked = BLOCKED_COLUMNS[tableName] || [];
    if (blocked.includes(columnName)) {
      // Hard: security violation — caller must know
      scanErrors.push(`Column '${tableName}.${columnName}' is not accessible`);
      return;
    }

    if (!tableColumns.has(tableName)) tableColumns.set(tableName, new Set());
    tableColumns.get(tableName).add(columnName);

    // Recurse into nested defaults
    for (const mod of parts.slice(1)) {
      if (mod.startsWith('default:')) {
        const inner = mod.slice(8).trim();
        if (inner.startsWith('{{') && inner.endsWith('}}')) {
          scanContent(inner.slice(2, -2), depth + 1);
        }
      }
    }
  };

  for (const { match } of findPlaceholders(text)) {
    scanContent(match.slice(2, -2)); // strip {{ }}
  }

  if (scanErrors.length) {
    return { status: 'failed', text, unresolved: [], errors: scanErrors, errorType: 'security' };
  }

  if (tableColumns.size === 0) {
    return { status: 'success', text, unresolved: [] };
  }

  // ── Step 2: Validate refs ──

  const missingRefs = [...tableColumns.keys()].filter(t => !refs[t]);
  if (missingRefs.length) {
    return {
      status: 'failed', text, unresolved: [],
      errors: [`Missing refs for tables: ${missingRefs.join(', ')}`],
      errorType: 'missing_refs'
    };
  }

  // ── Step 3: Build query ──
  // First table in the map → FROM. All others → LEFT JOIN.
  // LEFT JOIN ensures a missing anchor in one table doesn't null the whole row.
  // All columns aliased as `table__column` to prevent name collisions.

  const selectParts = [];
  const joinParts   = [];
  const params      = [];
  let   baseTable   = null;
  let   baseRefCol  = null;
  let   baseRefVal  = null;

  for (const tableName of tableColumns.keys()) {
    const ref    = refs[tableName];
    const refCol = Object.keys(ref)[0];
    const refVal = ref[refCol];

    // Safety: identifier validation (prevents SQL injection via table/column names)
    if (!/^\w+$/.test(tableName) || !/^\w+$/.test(refCol)) {
      return { status: 'failed', text, unresolved: [], errors: [`Invalid identifier in refs for '${tableName}'`] };
    }

    const blocked = BLOCKED_COLUMNS[tableName] || [];
    if (blocked.includes(refCol)) {
      return { status: 'failed', text, unresolved: [], errors: [`Ref column '${tableName}.${refCol}' is not accessible`] };
    }

    // Columns to select for this table (ref col + all referenced columns)
    const cols = [...new Set([refCol, ...tableColumns.get(tableName)])];
    for (const col of cols) {
      if (!/^\w+$/.test(col)) continue;
      selectParts.push(`\`${tableName}\`.\`${col}\` AS \`${tableName}__${col}\``);
    }

    if (!baseTable) {
      baseTable  = tableName;
      baseRefCol = refCol;
      baseRefVal = refVal;
    } else {
      // LEFT JOIN — if this anchor doesn't match, columns come back NULL
      // rather than nuking the entire row
      joinParts.push(`LEFT JOIN \`${tableName}\` ON \`${tableName}\`.\`${refCol}\` = ?`);
      params.push(refVal);
    }
  }

  const sql = [
    `SELECT ${selectParts.join(', ')}`,
    `FROM \`${baseTable}\``,
    ...joinParts,
    `WHERE \`${baseTable}\`.\`${baseRefCol}\` = ?`,
    'LIMIT 1'
  ].join(' ');

  params.push(baseRefVal);

  // ── Step 4: Execute ──

  // Note on error handling: we deliberately do NOT catch DB errors here.
  // A DB connection blip / deadlock during placeholder resolution is an
  // infrastructure failure, not a semantic resolver failure. Returning
  // status='failed' would mask it as permanent (e.g. campaignService would
  // record the contact as permanently failed and the job system would not
  // retry). Letting the error propagate lets the caller / job system decide
  // whether to retry. We still log here so the SQL is captured for debugging.
  let row;
  try {
    const [rows] = await db.query(sql, params);
    row = rows[0] || null;
  } catch (err) {
    console.error('[resolver] Query failed:', err.message, '\nSQL:', sql);
    throw err;
  }

  if (!row) {
    const allUnresolved = findPlaceholders(text).map(p => p.match);
    const status = strict ? 'failed' : 'partial_success';
    return { status, text, unresolved: allUnresolved };
  }

  // ── Step 5: Resolve placeholders against row data ──

  const unresolved = new Set();

  const resolveContent = (content, depth = 0) => {
    if (depth > 20) return null;

    const parts = splitParts(content);
    if (!parts.length) return null;

    const [entityField, ...modifiers] = parts;
    const dotIdx = entityField.indexOf('.');
    if (dotIdx === -1) return null;

    const tableName  = entityField.slice(0, dotIdx).trim();
    const columnName = entityField.slice(dotIdx + 1).trim();
    const aliasKey   = `${tableName}__${columnName}`;

    let value = (row[aliasKey] !== undefined && row[aliasKey] !== '') ? row[aliasKey] : null;

    // Apply defaults (in order, stop at first non-null result)
    for (const mod of modifiers) {
      if (value !== null) break;
      if (!mod.startsWith('default:')) continue;

      const defaultContent = mod.slice(8).trim();
      if (defaultContent.startsWith('{{') && defaultContent.endsWith('}}')) {
        value = resolveContent(defaultContent.slice(2, -2), depth + 1);
      } else {
        value = defaultContent;
      }
    }

    if (value === null) return null;

    // Apply remaining modifiers
    for (const mod of modifiers) {
      if (mod.startsWith('default:')) continue;

      if (mod.startsWith('date:') || mod.startsWith('time:') || mod.startsWith('datetime:')) {
        const fmt       = mod.slice(mod.indexOf(':') + 1);
        const formatted = formatDate(value, fmt);
        if (formatted !== null) value = formatted;
      } else if (mod === 'phone') {
        value = formatPhone(value);
      } else if (mod === 'email_mask') {
        value = maskEmail(String(value));
      } else if (['upper','uppercase','lower','lowercase','cap','capitalize'].includes(mod)) {
        value = applyTextTransform(String(value), mod);
      }
    }

    return value !== null ? String(value) : null;
  };

  // One pass — our scanner handles nesting so no loop needed
  const output = replacePlaceholders(text, match => {
    const inner    = match.slice(2, -2);
    const resolved = resolveContent(inner);
    if (resolved === null) unresolved.add(match);
    return resolved;
  });

  const status = unresolved.size === 0
    ? 'success'
    : strict ? 'failed' : 'partial_success';

  return {
    status,
    text:       output,
    unresolved: [...unresolved]
  };
}

module.exports = { resolve, ALLOWED_TABLES, BLOCKED_COLUMNS };