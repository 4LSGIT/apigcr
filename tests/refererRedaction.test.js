/**
 * tests/refererRedaction.test.js
 *
 * SEC-1 — credential-in-URL redaction at the jwt_api_audit_log write.
 *
 * Contracts pinned here:
 *   redactUrlParams: value of any credential-shaped query param →
 *     "[REDACTED]" (name kept), exact names only, case-insensitive,
 *     multiple params handled, fragment-safe, non-URL-ish strings and
 *     non-strings untouched, benign paths like /password-reset survive.
 *   logJwtApiAttempt: headers.referer and the route (originalUrl) land
 *     redacted; parsed query params matching the name set land redacted
 *     (case-insensitively); a secret planted in any of the three never
 *     reaches the INSERT params. Breaking the redactor (e.g. deleting the
 *     referer line or the redactUrlParams call on originalUrl) makes the
 *     "secret appears nowhere" assertions fail — that is the mutation bite.
 *
 * Run:
 *   npx jest tests/refererRedaction.test.js
 */

const SECRET = "FAKEhunter2xyz"; // never a real credential — test literal only

beforeEach(() => {
  jest.resetModules();
});

// ── redactUrlParams unit ────────────────────────────────────────────────────

test("real leak shape: pass value redacted, name and other params kept", () => {
  const { redactUrlParams } = require("../lib/auth.jwtOrApiKey");
  expect(
    redactUrlParams(`https://app.4lsg.com/?user=alice&pass=${SECRET}&qp=ab,cd&case=12,tab`)
  ).toBe("https://app.4lsg.com/?user=alice&pass=[REDACTED]&qp=ab,cd&case=12,tab");
});

test("benign /password-reset path with no matching param survives unchanged", () => {
  const { redactUrlParams } = require("../lib/auth.jwtOrApiKey");
  const u = "https://app.4lsg.com/password-reset?id=5&step=2";
  expect(redactUrlParams(u)).toBe(u);
});

test("multiple matching params all redacted; non-matching survive", () => {
  const { redactUrlParams } = require("../lib/auth.jwtOrApiKey");
  expect(
    redactUrlParams("https://x.com/p?token=t0k&foo=1&secret=s3c&apikey=k1&api_key=k2&keep=yes")
  ).toBe("https://x.com/p?token=[REDACTED]&foo=1&secret=[REDACTED]&apikey=[REDACTED]&api_key=[REDACTED]&keep=yes");
});

test("no query string / empty value / fragment: untouched or value-only redaction", () => {
  const { redactUrlParams } = require("../lib/auth.jwtOrApiKey");
  expect(redactUrlParams("https://app.4lsg.com/case.html")).toBe("https://app.4lsg.com/case.html");
  expect(redactUrlParams("https://app.4lsg.com/?pass=&x=1")).toBe("https://app.4lsg.com/?pass=&x=1");
  expect(redactUrlParams("https://a.com/?pass=abc#frag")).toBe("https://a.com/?pass=[REDACTED]#frag");
});

test("case-insensitive names; exact names only (lookalikes survive)", () => {
  const { redactUrlParams } = require("../lib/auth.jwtOrApiKey");
  expect(redactUrlParams("https://a.com/?PASS=Up&Token=Mix")).toBe(
    "https://a.com/?PASS=[REDACTED]&Token=[REDACTED]"
  );
  const lookalikes = "https://a.com/?passenger=2&bypass=1&monkey=3&authored=x&keynote=1";
  expect(redactUrlParams(lookalikes)).toBe(lookalikes);
});

test("non-string input passes through", () => {
  const { redactUrlParams } = require("../lib/auth.jwtOrApiKey");
  expect(redactUrlParams(undefined)).toBe(undefined);
  expect(redactUrlParams(null)).toBe(null);
  expect(redactUrlParams(42)).toBe(42);
});

// ── logJwtApiAttempt integration ────────────────────────────────────────────

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

test("audit write redacts referer, originalUrl and parsed query — secret reaches no column", async () => {
  const { logJwtApiAttempt } = require("../lib/auth.jwtOrApiKey");
  const { req, captured } = capturingReq({
    originalUrl: `/api/report?from=2026-01-01&PASS=${SECRET}`,
    headers: {
      "user-agent": "jest",
      referer: `https://app.4lsg.com/?user=alice&pass=${SECRET}&qp=ab`,
    },
    query: { from: "2026-01-01", PASS: SECRET },
  });

  await logJwtApiAttempt(req, "jwt", "alice", "authorized");

  expect(captured.params).not.toBeNull();
  const [route, , headersJson, queryJson] = captured.params;

  // route (originalUrl) — name kept, value gone
  expect(route).toBe("/api/report?from=2026-01-01&PASS=[REDACTED]");

  // headers.referer — redacted inside the stored JSON
  expect(JSON.parse(headersJson).referer).toBe(
    "https://app.4lsg.com/?user=alice&pass=[REDACTED]&qp=ab"
  );

  // parsed query — case-insensitive name match
  expect(JSON.parse(queryJson)).toEqual({ from: "2026-01-01", PASS: "[REDACTED]" });

  // mutation bite: bypass ANY of the three redaction sites and this fails
  for (const p of captured.params) {
    expect(String(p)).not.toContain(SECRET);
  }
});

test("audit write without referer or query secrets is unchanged in shape", async () => {
  const { logJwtApiAttempt } = require("../lib/auth.jwtOrApiKey");
  const { req, captured } = capturingReq({
    // A non-search param: ?q= is redacted since access-control B2 (its own
    // rule — tests/searchRedaction.test.js), so this "nothing secret" shape
    // check uses a plain filter instead.
    originalUrl: "/api/cases?status=open",
    query: { status: "open" },
  });

  await logJwtApiAttempt(req, "jwt", "alice", "authorized");

  const [route, method, headersJson, queryJson] = captured.params;
  expect(route).toBe("/api/cases?status=open");
  expect(method).toBe("GET");
  expect(JSON.parse(headersJson)).toEqual({ "user-agent": "jest" });
  expect(JSON.parse(queryJson)).toEqual({ status: "open" });
});
