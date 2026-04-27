// lib/ssrfGuard.js
//
// Pre-flight URL validation for outbound requests the server makes on behalf
// of a user (currently: /admin/api-tester; future: any admin tool that lets
// a human point YC at an arbitrary URL).
//
// Validates protocol + hostname, resolves to all A/AAAA records, and rejects
// if any resolved IP falls in a blocked range:
//   • IPv4: loopback, RFC1918, link-local (incl. 169.254.169.254 GCP/AWS
//          metadata), CGNAT, multicast, reserved, broadcast
//   • IPv6: ::, ::1, link-local fe80::/10, ULA fc00::/7, multicast ff00::/8,
//          and IPv4-mapped forms (::ffff:a.b.c.d) — recursively checked
//          against the IPv4 ruleset (the sneaky bypass)
//
// KNOWN LIMITATION — TOCTOU window: this validates DNS at gate time, but the
// fetch call below does its own lookup. A hostile DNS server could swap the
// answer between our check and fetch's connect. Closing this fully requires
// a custom http.Agent that re-validates the IP at connect time. Acceptable
// risk for admin-only, audit-logged, rate-limited use; revisit if this gate
// is ever adopted for routes with broader exposure.

const dns = require('dns').promises;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const V4_BLOCKED_CIDRS = [
  '0.0.0.0/8',       // "this network" / unspecified
  '10.0.0.0/8',      // RFC1918 private
  '100.64.0.0/10',   // CGNAT — used inside cloud platforms
  '127.0.0.0/8',     // loopback
  '169.254.0.0/16',  // link-local — GCP/AWS instance metadata lives at .169.254
  '172.16.0.0/12',   // RFC1918 private
  '192.0.0.0/24',    // protocol assignments
  '192.168.0.0/16',  // RFC1918 private
  '198.18.0.0/15',   // benchmarking
  '224.0.0.0/4',     // multicast
  '240.0.0.0/4',     // reserved (incl. 255.255.255.255 broadcast)
];

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] * 0x1000000) + (parts[1] * 0x10000) + (parts[2] * 0x100) + parts[3]) >>> 0;
}

function inV4Cidr(ip, cidr) {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isBlockedIpv4(ip) {
  return V4_BLOCKED_CIDRS.some(cidr => inV4Cidr(ip, cidr));
}

// IPv6 block check. dns.lookup typically returns canonical lower-case form
// without zone IDs, but we strip `%...` defensively.
function isBlockedIpv6(addr) {
  let a = String(addr).toLowerCase();
  const pct = a.indexOf('%');
  if (pct >= 0) a = a.slice(0, pct);

  if (a === '::' || a === '::1') return true;

  // IPv4-mapped IPv6 — must check the underlying IPv4 against the v4 ruleset.
  // Without this, ::ffff:169.254.169.254 (or ::ffff:127.0.0.1) bypasses.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isBlockedIpv4(mapped[1]);

  // Some stacks emit the mapped form as a hex pair (::ffff:a9fe:a9fe).
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low  = parseInt(mappedHex[2], 16);
    const v4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isBlockedIpv4(v4);
  }

  // Link-local fe80::/10 — third hex char is 8/9/a/b
  if (/^fe[89ab]/.test(a)) return true;
  // Unique-local fc00::/7 — fc.. or fd..
  if (/^f[cd]/.test(a)) return true;
  // Multicast ff00::/8
  if (/^ff/.test(a)) return true;

  return false;
}

function isBlockedIp(address, family) {
  if (family === 6) return isBlockedIpv6(address);
  if (family === 4) return isBlockedIpv4(address);
  return true; // unknown family — fail closed
}

/**
 * Parse + validate URL syntax + protocol. Returns the parsed URL.
 * Throws on malformed / non-http(s) / missing hostname.
 */
function validateUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString.trim()) {
    throw new Error('URL is required');
  }
  let url;
  try { url = new URL(urlString); }
  catch (e) { throw new Error(`Invalid URL: ${e.message}`); }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Protocol not allowed: ${url.protocol} (only http and https)`);
  }
  if (!url.hostname) throw new Error('URL is missing a hostname');
  return url;
}

/**
 * Resolve hostname; reject if any returned IP is in a blocked range.
 * Uses dns.lookup (OS resolver / getaddrinfo) — same path fetch will use
 * moments later (modulo TOCTOU window noted at the top of the file).
 */
async function assertSafeHostname(hostname) {
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error(`Hostname could not be resolved: ${hostname} (${e.code || e.message})`);
  }
  if (!addresses || !addresses.length) {
    throw new Error(`Hostname resolved to no addresses: ${hostname}`);
  }
  for (const { address, family } of addresses) {
    if (isBlockedIp(address, family)) {
      throw new Error(`Blocked: ${hostname} resolves to ${address} (private/loopback/metadata range)`);
    }
  }
  return addresses;
}

/** Combined: validate URL, then assert hostname safe. */
async function assertSafeUrl(urlString) {
  const url = validateUrl(urlString);
  const addresses = await assertSafeHostname(url.hostname);
  return { url, addresses };
}

module.exports = {
  validateUrl,
  isBlockedIp,
  isBlockedIpv4,
  isBlockedIpv6,
  assertSafeHostname,
  assertSafeUrl,
};