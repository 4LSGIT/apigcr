/**
 * Hook Transforms — Pure Transform Function Library
 * services/hookTransforms.js
 *
 * Each transform is a pure function: (value, ...args) => newValue
 * Used by the mapper engine (hookMapper.js) in both rule-level
 * transforms arrays and inline {{path|transform}} pipes.
 *
 * Usage:
 *   const { applyTransform, applyChain } = require('./hookTransforms');
 *   const result = applyTransform('uppercase', 'hello');        // → 'HELLO'
 *   const result = applyChain('hello world', ['trim', 'uppercase']); // → 'HELLO WORLD'
 */

const { DateTime } = require('luxon');

// ─────────────────────────────────────────────────────────────
// TRANSFORM REGISTRY
// ─────────────────────────────────────────────────────────────

const transforms = {};

// ── Text ──

transforms.lowercase = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

transforms.uppercase = (v) => (typeof v === 'string' ? v.toUpperCase() : v);

transforms.capitalize = (v) => {
  if (typeof v !== 'string') return v;
  return v.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
};

transforms.cap_first = (v) => {
  if (typeof v !== 'string' || !v.length) return v;
  return v.charAt(0).toUpperCase() + v.slice(1);
};

transforms.trim = (v) => (typeof v === 'string' ? v.trim() : v);

transforms.slug = (v) => {
  if (typeof v !== 'string') return v;
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
};

// ── Extraction ──

transforms.between = (v, start, end) => {
  if (typeof v !== 'string') return v;
  const s = v.indexOf(start);
  if (s === -1) return '';
  const after = s + start.length;
  const e = v.indexOf(end, after);
  if (e === -1) return v.slice(after);
  return v.slice(after, e);
};

transforms.before = (v, delimiter) => {
  if (typeof v !== 'string') return v;
  const i = v.indexOf(delimiter);
  return i === -1 ? v : v.slice(0, i);
};

transforms.after = (v, delimiter) => {
  if (typeof v !== 'string') return v;
  const i = v.indexOf(delimiter);
  return i === -1 ? v : v.slice(i + delimiter.length);
};

transforms.regex = (v, pattern) => {
  if (typeof v !== 'string') return v;
  try {
    const match = v.match(new RegExp(pattern));
    // Return first capture group if present, else full match
    return match ? (match[1] !== undefined ? match[1] : match[0]) : '';
  } catch {
    return '';
  }
};

// ── Manipulation ──

transforms.split = (v, delimiter, index) => {
  if (typeof v !== 'string') return v;
  const parts = v.split(delimiter);
  const i = parseInt(index, 10);
  return isNaN(i) ? parts : (parts[i] ?? '');
};

transforms.replace = (v, find, replacement) => {
  if (typeof v !== 'string') return v;
  // Replace all occurrences
  return v.split(find).join(replacement ?? '');
};

transforms.prefix = (v, str) => {
  if (v == null || v === '') return v;
  return String(str ?? '') + String(v);
};

transforms.suffix = (v, str) => {
  if (v == null || v === '') return v;
  return String(v) + String(str ?? '');
};

transforms.join = (v, delimiter) => {
  if (!Array.isArray(v)) return v;
  return v.join(delimiter ?? ', ');
};

transforms.at = (v, index) => {
  const i = parseInt(index, 10);
  if (Array.isArray(v)) return v[i] ?? null;
  if (v && typeof v === 'object') return v[index] ?? null;
  return v;
};

// ── Formatting ──

transforms.digits_only = (v) => {
  if (typeof v !== 'string' && typeof v !== 'number') return v;
  return String(v).replace(/\D/g, '');
};

transforms.phone = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return v;
};

transforms.date = (v, format) => {
  if (!v || !format) return v;
  try {
    // Try ISO first, then common formats
    let dt = DateTime.fromISO(String(v));
    if (!dt.isValid) dt = DateTime.fromSQL(String(v));
    if (!dt.isValid) dt = DateTime.fromRFC2822(String(v));
    if (!dt.isValid) dt = DateTime.fromHTTP(String(v));
    if (!dt.isValid) return v;
    return dt.toFormat(format);
  } catch {
    return v;
  }
};

transforms.tz = (v, zone) => {
  if (!v || !zone) return v;
  try {
    let dt = DateTime.fromISO(String(v), { zone: 'utc' });
    if (!dt.isValid) dt = DateTime.fromSQL(String(v), { zone: 'utc' });
    if (!dt.isValid) dt = DateTime.fromRFC2822(String(v));
    if (!dt.isValid) return v;
    return dt.setZone(zone).toISO();
  } catch {
    return v;
  }
};

transforms.number = (v) => {
  const n = Number(v);
  return isNaN(n) ? v : n;
};

transforms.boolean = (v) => {
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase().trim();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
  return v;
};

// ── Fallbacks ──

transforms.default = (v, fallback) => {
  if (v == null || v === '') return fallback ?? '';
  return v;
};

transforms.required = (v) => {
  if (v == null || v === '') {
    throw new Error('Required field is missing or empty');
  }
  return v;
};


// ─────────────────────────────────────────────────────────────
// PARSER — parse "transformName:arg1:arg2" strings
// ─────────────────────────────────────────────────────────────

/**
 * Parse a transform descriptor string into { name, args }.
 * Format: "name" or "name:arg1:arg2:..."
 *
 * Colons inside args can be escaped with backslash: "between:Name\\::;"
 *
 * @param {string} descriptor
 * @returns {{ name: string, args: string[] }}
 */
function parseTransformDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'string') {
    return { name: '', args: [] };
  }

  // Split on unescaped colons
  const parts = [];
  let current = '';
  for (let i = 0; i < descriptor.length; i++) {
    if (descriptor[i] === '\\' && i + 1 < descriptor.length) {
      // Escaped character — include the next char literally
      current += descriptor[i + 1];
      i++;
    } else if (descriptor[i] === ':') {
      parts.push(current);
      current = '';
    } else {
      current += descriptor[i];
    }
  }
  parts.push(current);

  return {
    name: parts[0],
    args: parts.slice(1),
  };
}


// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * Apply a single transform by descriptor string.
 * @param {string} descriptor  - e.g. "uppercase" or "date:yyyy-MM-dd"
 * @param {*} value
 * @returns {*}
 */
function applyTransform(descriptor, value) {
  const { name, args } = parseTransformDescriptor(descriptor);
  const fn = transforms[name];
  if (!fn) throw new Error(`Unknown transform: "${name}"`);
  return fn(value, ...args);
}

/**
 * Apply a chain of transforms in order.
 * @param {*} value
 * @param {string[]} chain  - array of descriptor strings
 * @returns {*}
 */
function applyChain(value, chain) {
  if (!Array.isArray(chain) || !chain.length) return value;
  let result = value;
  for (const descriptor of chain) {
    result = applyTransform(descriptor, result);
  }
  return result;
}

/**
 * List all available transform names (for UI/docs).
 * @returns {string[]}
 */
function listTransforms() {
  return Object.keys(transforms).sort();
}


module.exports = {
  applyTransform,
  applyChain,
  parseTransformDescriptor,
  listTransforms,
  // Expose registry for testing individual transforms
  transforms,
};