// tests/moduleLoad.smoke.test.js
//
// Load-time smoke test: require() every module in services/, routes/, lib/,
// and lib/internal_functions/ and assert none throws.
//
// Motivation (2026-07-17 incident): Slice C1 removed parseFirmDomains from
// services/emailIngestService.js but left it in module.exports — a
// ReferenceError at require time. routes/api.emailIngest.js requires that
// service at boot, and routes auto-mount, so every new Cloud Run instance
// crashed on startup while old instances kept serving. Nothing in the test
// suite exercised a bare require of the file, so it shipped. This test makes
// that whole failure class impossible to ship again.
//
// Notes:
// - jest.useFakeTimers() runs BEFORE any require so module-scope timers
//   (e.g. routes/api.email_router.js's setInterval) don't hold the process
//   open. mysql2 pools connect lazily, so startup/db requires are safe.
// - If a module ever legitimately cannot load in the test environment,
//   add it to SKIP with a comment saying why — don't delete the test.

const fs = require("fs");
const path = require("path");

jest.useFakeTimers();

// Fail-fast env: several modules deliberately throw at load without these
// (prod-correct design, not the bug class this suite hunts). Seed dummies —
// no network happens at require.
if (!process.env.CREDENTIALS_ENCRYPTION_KEY) {
  process.env.CREDENTIALS_ENCRYPTION_KEY =
    require("crypto").randomBytes(32).toString("base64");
}
for (const k of ["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET", "DROPBOX_REFRESH_TOKEN"]) {
  if (!process.env[k]) process.env[k] = "smoke-test-dummy";
}

const ROOT = path.join(__dirname, "..");

// Relative paths (posix-style) of modules that may not load under test.
const SKIP = new Set([
  // (empty — everything must load)
]);

function jsFilesIn(dir, recursive = false) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (recursive) out.push(...jsFilesIn(path.join(dir, entry.name), true));
      continue;
    }
    if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
      out.push(path.posix.join(dir, entry.name));
    }
  }
  return out;
}

const targets = [
  ...jsFilesIn("services"),
  ...jsFilesIn("routes"),
  ...jsFilesIn("lib"),
  ...jsFilesIn("lib/internal_functions"),
].filter((f) => !SKIP.has(f));

describe("every module loads without throwing", () => {
  test("found a sane number of modules", () => {
    // Guard against the walker silently matching nothing after a re-org.
    expect(targets.length).toBeGreaterThan(20);
  });

  test.each(targets)("%s", (rel) => {
    expect(() => require(path.join(ROOT, rel))).not.toThrow();
  });
});