/**
 * tests/searchRedaction.test.js
 *
 * Search-term redaction at the jwt_api_audit_log write — access-control B2
 * addendum (lib/auth.jwtOrApiKey.js redactSearchParams + logJwtApiAttempt).
 * A SEPARATE rule from SEC-1's credential list (tests/refererRedaction.test.js
 * is that one's pattern, mirrored here): `q` is not a credential, it is what
 * someone typed into a search box — and the table is session-key readable.
 *
 * Contracts pinned here:
 *   redactSearchParams: the VALUE of `q` → "[REDACTED]" (name kept), exact
 *     name only (?quality= / ?quick= / ?faq= survive), case-insensitive,
 *     first or later position, fragment-safe, empty value left alone,
 *     non-strings untouched; the credential regex is NOT widened (`q` is not
 *     in redactUrlParams' set).
 *   logJwtApiAttempt: a search term planted in the URL, the parsed query and a
 *     POST body {q} reaches no INSERT param; look-alike names keep their values.
 *
 * Run:
 *   npx jest tests/searchRedaction.test.js
 */

const TERM = "FAKEclientname-5551234"; // a stand-in search term, not real data

beforeEach(() => {
  jest.resetModules();
});

test("q value redacted, name and other params kept, any position", () => {
  const { redactSearchParams } = require("../lib/auth.jwtOrApiKey");
  expect(redactSearchParams(`/api/mail/messages?q=${TERM}&limit=50`)).toBe("/api/mail/messages?q=[REDACTED]&limit=50");
  expect(redactSearchParams(`/api/mail/messages?limit=50&q=${TERM}`)).toBe("/api/mail/messages?limit=50&q=[REDACTED]");
  expect(redactSearchParams(`/api/search?Q=${TERM}#top`)).toBe("/api/search?Q=[REDACTED]#top");
});

test("exact name only: look-alikes survive; an empty q is left alone", () => {
  const { redactSearchParams } = require("../lib/auth.jwtOrApiKey");
  const lookalikes = "/x?quality=high&quick=1&faq=2&seq=3&qq=4&query_id=5";
  expect(redactSearchParams(lookalikes)).toBe(lookalikes);
  expect(redactSearchParams("/api/search?q=&type=all")).toBe("/api/search?q=&type=all");
});

test("non-string input passes through", () => {
  const { redactSearchParams } = require("../lib/auth.jwtOrApiKey");
  expect(redactSearchParams(undefined)).toBe(undefined);
  expect(redactSearchParams(null)).toBe(null);
  expect(redactSearchParams(7)).toBe(7);
});

test("kept separate: the credential redactor does not touch q", () => {
  const { redactUrlParams } = require("../lib/auth.jwtOrApiKey");
  expect(redactUrlParams(`/api/search?q=${TERM}`)).toBe(`/api/search?q=${TERM}`);
});

function capturingReq(extra = {}) {
  const captured = { params: null };
  const req = {
    originalUrl: "/api/tasks",
    method: "GET",
    headers: { "user-agent": "jest" },
    query: {},
    body: {},
    socket: { remoteAddress: "127.0.0.1" },
    db: {
      query: jest.fn((sql, params) => {
        if (sql.includes("jwt_api_audit_log")) captured.params = params;
        return Promise.resolve([{}]);
      }),
    },
    ...extra,
  };
  return { req, captured };
}

test("audit write: the term reaches no column — URL, parsed query, referer", async () => {
  const { logJwtApiAttempt } = require("../lib/auth.jwtOrApiKey");
  const { req, captured } = capturingReq({
    originalUrl: `/api/mail/messages?q=${TERM}&quality=high&limit=50`,
    headers: { "user-agent": "jest", referer: `https://app.4lsg.com/comms?q=${TERM}` },
    query: { q: TERM, quality: "high", limit: "50" },
  });
  await logJwtApiAttempt(req, "jwt", "alice", "authorized");
  const [route, , headersJson, queryJson] = captured.params;
  expect(route).toBe("/api/mail/messages?q=[REDACTED]&quality=high&limit=50");
  expect(JSON.parse(queryJson)).toEqual({ q: "[REDACTED]", quality: "high", limit: "50" });
  expect(JSON.parse(headersJson).referer).toBe("https://app.4lsg.com/comms?q=[REDACTED]");
  for (const p of captured.params) expect(String(p)).not.toContain(TERM);
});

test("audit write: a POST body {q} (comms S6 search) is redacted; other body keys kept", async () => {
  const { logJwtApiAttempt } = require("../lib/auth.jwtOrApiKey");
  const { req, captured } = capturingReq({
    originalUrl: "/api/comms-archive/search",
    method: "POST",
    body: { q: TERM, line_id: 4, cursor: "abc", limit: 20, quick: "yes" },
  });
  await logJwtApiAttempt(req, "jwt", "alice", "authorized");
  const body = JSON.parse(captured.params[4]);
  expect(body).toEqual({ q: "[REDACTED]", line_id: 4, cursor: "abc", limit: 20, quick: "yes" });
  for (const p of captured.params) expect(String(p)).not.toContain(TERM);
});

test("credentials and search terms together: both rules apply", async () => {
  const { logJwtApiAttempt } = require("../lib/auth.jwtOrApiKey");
  const { req, captured } = capturingReq({
    originalUrl: `/api/x?pass=FAKEhunter2xyz&q=${TERM}`,
    query: { pass: "FAKEhunter2xyz", q: TERM },
  });
  await logJwtApiAttempt(req, "jwt", "alice", "authorized");
  expect(captured.params[0]).toBe("/api/x?pass=[REDACTED]&q=[REDACTED]");
  expect(JSON.parse(captured.params[3])).toEqual({ pass: "[REDACTED]", q: "[REDACTED]" });
});
