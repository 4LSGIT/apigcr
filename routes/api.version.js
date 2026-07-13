// routes/api.version.js
//
// GET /api/version — which build of the code is this instance running, and is
// there a force-reload floor in effect.
//
// Polled by the browser shell (public/js/versionGuard.js):
//   build !== the build the tab booted on   → "update available" banner
//   the tab's build is older than minBuild  → forced reload
//
// Deliberately UNAUTHENTICATED:
//   - the shell must be able to check before a JWT exists (and while the login
//     modal is up), and
//   - a Cloud Run revision name and a date are not sensitive.
// The minBuild read is cached for 30s inside lib/appBuild.js, so no amount of
// polling turns this into DB load.
//
// `minBuildIso` is purely so you can eyeball the Settings value you just typed
// and confirm it parsed the way you meant. If you fat-finger it, minBuild comes
// back 0 and nothing is forced.

const express = require("express");
const router = express.Router();
const appBuild = require("../lib/appBuild");

router.get("/api/version", async (req, res) => {
  let minBuild = 0;
  try {
    minBuild = await appBuild.getMinBuild(req.db);
  } catch (_) {
    minBuild = 0; // fail open — never force a reload because the DB hiccuped
  }

  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.json({
    build: appBuild.build, // identity — changes on every deploy
    mtime: appBuild.mtime, // monotonic build stamp; the axis minBuild is compared on
    minBuild, // 0 = no floor (normal)
    minBuildIso: minBuild ? new Date(minBuild).toISOString() : null,
    revision: appBuild.revision, // K_REVISION on Cloud Run, else null
    startedAt: appBuild.startedAt, // this instance's boot time (NOT the build id)
    now: new Date().toISOString(),
  });
});
//test3
module.exports = router;