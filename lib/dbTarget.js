// lib/dbTarget.js
//
// Where a mysql2 pool connects: a Cloud SQL Unix socket, or host TCP.
//
// One env var decides, for both pools (startup/db.js, startup/dbReadonly.js):
//
//   INSTANCE_CONNECTION_NAME = PROJECT:REGION:INSTANCE
//     set   → socketPath /cloudsql/<name>. Cloud Run mounts that socket when
//             the revision is deployed with --add-cloudsql-instances=<name>;
//             the connection is IAM-authorized and encrypted by the Cloud SQL
//             connector, so no IP allowlist, VPC connector or NAT is required.
//             This is production (since 2026-10-13).
//     unset → host TCP: a developer machine, through a local Cloud SQL Auth
//             Proxy on 127.0.0.1 (ref/INFRA_GCP.md §10) — and any plain MySQL
//             server, which is how production ran before the move.
//
// Never set the var in a local .env: the /cloudsql socket exists only on Cloud
// Run. mysql2 gives socketPath precedence over host/port
// (lib/base/connection.js: `if (opts.config.socketPath) Net.connect(socketPath)`),
// but host/port are deliberately LEFT OUT of the socket config anyway so a
// stale `host` env can never be mistaken for the live target in a config dump.
//
// Dependency-free and pure so it is unit-testable without building a pool.

const SOCKET_DIR = '/cloudsql';

// PROJECT:REGION:INSTANCE — three non-empty, colon-separated, whitespace-free
// parts. (Legacy domain-scoped projects, `domain.com:project:region:instance`,
// have four; accept those too rather than warn on a valid name.)
const INSTANCE_NAME_RE = /^[^:\s]+(:[^:\s]+){2,3}$/;

/**
 * @param {object} opts
 * @param {string} [opts.instance]  INSTANCE_CONNECTION_NAME value (may be unset)
 * @param {string} [opts.host]      TCP host, used only when `instance` is unset
 * @param {string|number} [opts.port] TCP port, used only when `instance` is unset;
 *                                  omitted from the result when falsy so mysql2
 *                                  applies its own default (3306)
 * @returns {{config: object, label: string, socket: boolean, warning: string|null}}
 *   config  — spread into mysql.createPool({...})
 *   label   — human-readable target for boot logs (never contains credentials)
 *   warning — non-null when `instance` is set but does not look like a
 *             connection name; the caller logs it. We still use the value: a
 *             malformed name fails at first query (ENOENT on the socket), and
 *             silently falling back to `host` would point a Cloud SQL deploy
 *             at the OLD database — the one failure this must never produce.
 */
function dbTarget({ instance, host, port } = {}) {
  const name = String(instance == null ? '' : instance).trim();

  if (name) {
    return {
      config: { socketPath: `${SOCKET_DIR}/${name}` },
      label: `socket:${name}`,
      socket: true,
      warning: INSTANCE_NAME_RE.test(name)
        ? null
        : `INSTANCE_CONNECTION_NAME "${name}" does not look like PROJECT:REGION:INSTANCE — ` +
          `connections will fail until it is corrected (NOT falling back to host).`,
    };
  }

  const config = { host };
  if (port) config.port = port;
  return { config, label: String(host), socket: false, warning: null };
}

module.exports = { dbTarget, SOCKET_DIR };
