/**
 * tests/auditHeaderRedaction.test.js
 *
 * Credential HEADERS never reach jwt_api_audit_log.headers.
 *
 * The old redaction deleted a fixed three (authorization, x-api-key,
 * cookie); x-su-elevation — the SU step-up token, sent by the shell on
 * every stepped-up request — was not among them and sat in 8,926 rows
 * (2026-08-16 → 2026-10-27). The redaction is now by header NAME
 * (CREDENTIAL_HEADER_RE), so these pins:
 *   - every credential header the app accepts is absent from the row, and
 *     its value appears in no INSERT param;
 *   - diagnostic headers survive (user-agent, content-type, x-app-build,
 *     x-forwarded-for, referer) — the regex must not blind the log.
 * Mutation bite: restore the three-name delete list and the x-su-elevation
 * (and every other non-classic) assertion fails.
 *
 * Run:
 *   npx jest tests/auditHeaderRedaction.test.js
 */

const SECRET = "FAKEelev0token9xyz"; // never a real credential — test literal only

beforeEach(() => {
  jest.resetModules();
});

function capture(headers) {
  const captured = { params: null };
  const req = {
    originalUrl: "/api/tasks",
    method: "POST",
    headers,
    query: {},
    body: {},
    socket: { remoteAddress: "127.0.0.1" },
    db: {
      query: jest.fn((sql, params) => {
        if (sql.includes("jwt_api_audit_log")) captured.params = params;
        return Promise.resolve([{}]);
      }),
    },
  };
  return { req, captured };
}

// Every header the app reads a credential from (grep req.headers / req.get).
const CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "x-api-key",
  "x-su-elevation",
  "x-readonly-api-key",
  "x-badge-token",
  "x-email-ingest-key",
  "x-courtexec-key",
  "x-aitest-key",
  "x-errtest-key",
  "x-streak-auth",
  "x-streak-admin",
];

const DIAGNOSTIC_HEADERS = {
  "user-agent": "jest",
  "content-type": "application/json",
  "x-app-build": "1234",
  "x-forwarded-for": "10.0.0.1",
  referer: "https://app.4lsg.com/case.html",
};

test.each(CREDENTIAL_HEADERS)("%s is dropped and its value reaches no column", async (name) => {
  const { logJwtApiAttempt } = require("../lib/auth.jwtOrApiKey");
  const { req, captured } = capture({ ...DIAGNOSTIC_HEADERS, [name]: `${SECRET}-${name}` });
  await logJwtApiAttempt(req, "jwt", "alice", "success");
  expect(captured.params).not.toBeNull();
  const headers = JSON.parse(captured.params[2]);
  expect(headers).not.toHaveProperty(name);
  expect(JSON.stringify(captured.params)).not.toContain(SECRET);
});

test("diagnostic headers survive the credential filter", async () => {
  const { logJwtApiAttempt } = require("../lib/auth.jwtOrApiKey");
  const { req, captured } = capture({ ...DIAGNOSTIC_HEADERS, "x-su-elevation": SECRET });
  await logJwtApiAttempt(req, "jwt", "alice", "success");
  const headers = JSON.parse(captured.params[2]);
  expect(headers).toEqual(DIAGNOSTIC_HEADERS);
});
