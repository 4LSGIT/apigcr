// lib/unplacehold.js
// lib/unplacehold.js
/*
 * unplacehold.js – Replace placeholders in text with entity data from DB (contact, case, appt)
 * 
 * Syntax:
 *   {{entity.field}}                          → basic replacement
 *   {{entity.field|modifier|modifier2}}       → chained modifiers
 *   {{entity.field|default:{{fallback}}|default:Value}} → chained/nested defaults
 *
 * Entities: contact, case, appt
 *
 * Modifiers (applied left-to-right after resolving value/default):
 *   default:VALUE or default:{{nested.placeholder}} → fallback if value missing/empty
 *   date:FORMAT, time:FORMAT, datetime:FORMAT
 *     Tokens: YYYY, MM, MMMM, MMM, DD, D, Do, DoW, dddd, ddd, HH, hh, h (unpadded), mm, ss, A
 *   phone → US phone format (e.g. 1234567890 → (123) 456-7890)
 *   email_mask → masked email (e.g. test@example.com → t***@e*****.com)
 *   upper / uppercase → ALL UPPERCASE
 *   lower / lowercase → all lowercase
 *   cap / capitalize → Title Case (each word capitalized)
 *
 * Rules:
 *   - Empty string ("") treated as missing → triggers default
 *   - Nested defaults resolved recursively (depth limit 20)
 *   - Modifiers after default apply to final value
 *   - Unknown modifiers ignored
 *   - Unresolved placeholders remain in output (without {{ }})
 *   - strict: true → status "failed" if unresolved; false → "partial_success"
 *
 * Returns:
 *   { status: "success" | "partial_success" | "failed",
 *     text: resolved string,
 *     unresolved: array of original unresolved placeholders }
 */
const pad = (n) => String(n).padStart(2, '0');

/* --- Date helpers --- */
const ORDINAL_WORDS = [
  "First","Second","Third","Fourth","Fifth","Sixth","Seventh","Eighth","Ninth","Tenth",
  "Eleventh","Twelfth","Thirteenth","Fourteenth","Fifteenth","Sixteenth","Seventeenth","Eighteenth","Nineteenth","Twentieth",
  "Twenty-first","Twenty-second","Twenty-third","Twenty-fourth","Twenty-fifth","Twenty-sixth","Twenty-seventh","Twenty-eighth","Twenty-ninth","Thirtieth",
  "Thirty-first"
];

const ordinal = (n) => {
  if (n % 100 >= 11 && n % 100 <= 13) return n + "th";
  switch (n % 10) {
    case 1: return n + "st";
    case 2: return n + "nd";
    case 3: return n + "rd";
    default: return n + "th";
  }
};

const ordinalWord = (n) => ORDINAL_WORDS[n - 1] || n;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_ABBR = ["Sun", "Mon", "Tues", "Wed", "Thurs", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];

const formatDate = (value, format) => {
  const d = new Date(value);
  if (isNaN(d)) return null;

  const tokens = {
    YYYY: d.getFullYear(),
    MM: pad(d.getMonth() + 1),
    MMMM: MONTHS[d.getMonth()],
    MMM: MONTHS_ABBR[d.getMonth()],
    DD: pad(d.getDate()),
    D: d.getDate(),
    Do: ordinal(d.getDate()),
    DoW: ordinalWord(d.getDate()),
    dddd: WEEKDAYS[d.getDay()],
    ddd: WEEKDAYS_ABBR[d.getDay()],
    HH: pad(d.getHours()),           // 00-23
    hh: pad(d.getHours() % 12 || 12), // 01-12
    h: d.getHours() % 12 || 12,      // 1-12 unpadded
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    A: d.getHours() >= 12 ? "PM" : "AM",
  };

  let output = format;
  Object.keys(tokens).sort((a, b) => b.length - a.length).forEach(t => {
    output = output.replaceAll(t, tokens[t]);
  });
  return output;
};

const formatPhone = (value) => {
  if (!value || typeof value !== 'string') return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length === 7) return `${digits.slice(0,3)}-${digits.slice(3)}`;
  return value;
};

const maskEmail = (email) => {
  if (!email || typeof email !== 'string' || !email.includes('@')) return email;

  const [local, domain] = email.split('@');
  const domainParts = domain.split('.');
  const tld = domainParts.pop();
  const domainName = domainParts.join('.');

  let maskedLocal = local[0];
  if (local.length > 1) {
    maskedLocal += '*'.repeat(Math.max(1, local.length - 2));
    if (local.length > 2) maskedLocal += local[local.length - 1];
  }

  let maskedDomain = domainName[0];
  if (domainName.length > 1) {
    maskedDomain += '*'.repeat(Math.max(1, domainName.length - 2));
    if (domainName.length > 2) maskedDomain += domainName[domainName.length - 1];
  }

  return `${maskedLocal}@${maskedDomain}.${tld}`;
};

const transformText = (value, modifier) => {
  if (typeof value !== 'string') return value;
  switch (modifier) {
    case 'uppercase':
    case 'upper':
      return value.toUpperCase();
    case 'lowercase':
    case 'lower':
      return value.toLowerCase();
    case 'capitalize':
    case 'cap':
      // Title case: capitalize each word
      return value
        .toLowerCase()
        .split(/\s+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    default:
      return value;
  }
};

/* --- Main exported function --- */
module.exports = async function unplacehold({
  db,
  text,
  contact_id,
  case_id,
  case_number,
  case_number_full,
  appt_id,
  strict = false,
}) {
  let contact = null;
  let caseData = null;
  let appt = null;

  const conn = await db.getConnection();
  try {
    if (contact_id) {
      const [rows] = await conn.query('SELECT * FROM contacts WHERE contact_id = ?', [contact_id]);
      if (rows.length) contact = rows[0];
    }
    if (case_id || case_number || case_number_full) {
      let query, params;
      if (case_id) { query = 'SELECT * FROM cases WHERE case_id = ?'; params = case_id; }
      else if (case_number_full) { query = 'SELECT * FROM cases WHERE case_number_full = ?'; params = case_number_full; }
      else { query = 'SELECT * FROM cases WHERE case_number = ?'; params = case_number; }
      const [rows] = await conn.query(query, [params]);
      if (rows.length) caseData = rows[0];
    }
    if (appt_id) {
      const [rows] = await conn.query('SELECT * FROM appts WHERE appt_id = ?', [appt_id]);
      if (rows.length) appt = rows[0];
    }
  } finally {
    conn.release();
  }

  const entities = { contact, case: caseData, appt };

  const unresolved = new Set();

  const resolvePlaceholder = (placeholder, depth = 0) => {
    if (depth > 20) {
      unresolved.add(placeholder);
      return placeholder;
    }

    const match = placeholder.match(/^{{(.+)}}$/);
    if (!match) return placeholder;

    const content = match[1];

    const parts = [];
    let current = '';
    let braceLevel = 0;
    for (const char of content) {
      if (char === '|' && braceLevel === 0) {
        parts.push(current.trim());
        current = '';
      } else {
        current += char;
        if (char === '{') braceLevel++;
        if (char === '}') braceLevel--;
      }
    }
    if (current.trim()) parts.push(current.trim());

    if (parts.length === 0) {
      unresolved.add(placeholder);
      return placeholder;
    }

    const entityField = parts[0];
    const modifiers = parts.slice(1);

    const [entityName, field] = entityField.split('.', 2);
    if (!entityName || !field || !['contact', 'case', 'appt'].includes(entityName)) {
      unresolved.add(placeholder);
      return placeholder;
    }

    let value = entities[entityName]?.[field];
    if (value === '') value = null;

    // Apply chained defaults
    for (const mod of modifiers) {
      if (value != null) break;
      if (!mod.startsWith('default:')) continue;

      const defaultContent = mod.slice(8).trim();
      if (defaultContent.startsWith('{{') && defaultContent.endsWith('}}')) {
        value = resolvePlaceholder(defaultContent, depth + 1);
      } else {
        value = defaultContent;
      }
    }

    // Apply all other modifiers
    for (const mod of modifiers) {
      if (mod.startsWith('default:')) continue;

      if (mod.startsWith('date:') || mod.startsWith('time:') || mod.startsWith('datetime:')) {
        const format = mod.slice(mod.indexOf(':') + 1);
        if (value) {
          const formatted = formatDate(value, format);
          if (formatted !== null) value = formatted;
        }
      } else if (mod === 'phone') {
        value = formatPhone(value);
      } else if (mod === 'email_mask') {
        value = maskEmail(value);
      } else if (['uppercase', 'upper', 'lowercase', 'lower', 'capitalize', 'cap'].includes(mod)) {
        value = transformText(value, mod);
      }
    }

    if (value == null) {
      unresolved.add(placeholder);
      return placeholder;
    }

    return value;
  };

  let output = text;
  let changed;
  do {
    changed = false;
    output = output.replace(/{{[^}]+}}/g, (match) => {
      const resolved = resolvePlaceholder(match);
      if (resolved !== match) changed = true;
      return resolved;
    });
  } while (changed);

  // Safety cleanup
  output = output.replace(/}}+/g, '');

  let status = 'success';
  if (unresolved.size > 0) {
    status = strict ? 'failed' : 'partial_success';
  }

  return {
    status,
    text: output,
    unresolved: Array.from(unresolved),
  };
};