// server.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();
const { alert } = require("./lib/alerting");

const appBuild = require("./lib/appBuild");
const db = require("./startup/db");

const app = express();
// exposedHeaders: lets a cross-origin caller read the build headers. Same-origin
// (the shell) can read them regardless, but a vanity-host page could not.
var corsOptions = {
  origin: "*",
  exposedHeaders: ["X-App-Build", "X-App-Min-Build"],
};
app.use(cors(corsOptions));
app.set('trust proxy', 1);//google cloud run

// Stamp EVERY response (API and static) with the build this instance is running,
// plus the force-reload floor if one is set. The browser shell records the build
// it booted on and shows an "update available" banner when the two diverge — or
// force-reloads if its build is below the floor. See public/js/versionGuard.js.
//
// These headers are a HINT, not the source of truth. X-App-Min-Build is read from
// a 30s cache (a header middleware cannot await a DB round-trip), so it can lag
// reality by up to half a minute in either direction. That is fine and by design:
// the client never acts on the header — it only uses it to decide whether to go
// ask GET /api/version, which awaits the real value and is authoritative.
//
// refreshMinBuild is fire-and-forget and internally throttled to one DB read per
// 30s per instance, so calling it on every request (static assets included) is
// free. Mounted before express.static so static responses carry the headers too.
app.use((req, res, next) => {
  res.set("X-App-Build", appBuild.build);
  const floor = appBuild.minBuildCached();
  if (floor) res.set("X-App-Min-Build", String(floor));
  appBuild.refreshMinBuild(db);
  next();
});
console.log(`app build: ${appBuild.build} (mtime ${appBuild.mtime})`);

// Capture raw body for webhook HMAC verification
app.use('/hooks', express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));
// Same treatment for /webhooks/* (e-sign providers). Two reasons, neither of
// which the generic parser below can serve:
//   1. Zoho Sign's webhook payload shape is undocumented, so slice 1C stores
//      each delivery VERBATIM against the signing request. Re-serializing the
//      parsed object would silently normalize key order, numeric precision and
//      unicode escaping — i.e. it would destroy the evidence we are collecting.
//   2. If a provider later signs its payloads, HMAC verification needs the
//      exact bytes. Retrofitting that after the fact means editing this file
//      under time pressure during an incident.
app.use('/webhooks', express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));
// Urlencoded deliveries to /webhooks/* get the same raw-body capture. Without
// this, a form-encoded webhook would be parsed by the GLOBAL urlencoded parser
// below (which has no verify hook), req.rawBody would stay unset, and HMAC
// verification over the wire bytes would be impossible for exactly that
// content-type. Parsers short-circuit on req._body, so this scoped one wins
// for /webhooks and the global one still serves everything else.
app.use('/webhooks', express.urlencoded({
  extended: true,
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));
app.use(express.json({ limit: '10mb' }));//maybe limit to /upload?
app.use(express.urlencoded({ extended: true }));
// Landing pages: vanity-host middleware must run BEFORE express.static so a
// mapped domain's root doesn't fall into public/index.html.
// (`db` is required at the top of the file — the build-header middleware needs it.)
app.use(require("./routes/pageLanding").pageHostMiddleware(db));
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, path, stat) => {
      if (path.endsWith(".js")) {
        res.set("Content-Type", "application/javascript");
      } else if (path.endsWith(".css")) {
        res.set("Content-Type", "text/css");
      }
      // Page HTML must always be revalidated. express.static's default of
      // `public, max-age=0` already forces a conditional GET, but `public` allows
      // a shared proxy to hold a copy — `private, no-cache` removes that whole
      // class of "I refreshed and still got the old page".
      if (path.endsWith(".html")) {
        res.set("Cache-Control", "private, no-cache, must-revalidate");
      }
    },
  })
);

//const db = require("./startup/db");//and we are going to attach it to each route


const routesPath = path.join(__dirname, "routes");

app.get("/:page", (req, res, next) => {
  const filePath = path.join(__dirname, "public", req.params.page + ".html");
  if (fs.existsSync(filePath)) {
    // Same rule as express.static above: HTML is always revalidated.
    return res.sendFile(filePath, {
      headers: { "Cache-Control": "private, no-cache, must-revalidate" },
    });
  }
  next(); // continue to normal routes if file doesn’t exist
});

app.use((req, res, next) => {
  req.db = db;
  next();
});

// 500-response observer — must mount BEFORE the route loop so every
// route's res is wrapped. Records ANY outgoing 5xx regardless of whether
// the route self-handled or called next(err). See lib/responseObserver.js.
app.use(require("./lib/responseObserver")(db));

// Process-level guards — registered once. unhandledRejection is the ONLY
// thing that catches async route handlers without try/catch (Express 4
// never routes those rejections to error middleware).
if (!global.__ycProcessGuards) {
  global.__ycProcessGuards = true;
  process.on("unhandledRejection", (reason) => {
    try {
      alert(db, {
        source: "app", kind: "unhandled_rejection", severity: "error",
        group_key: "app:unhandled_rejection",
        title: "Unhandled promise rejection",
        message: reason?.stack || String(reason),
      });
    } catch (_) {}
    console.error("[unhandledRejection]", reason);
    // do NOT exit — the process is still coherent; the request just hangs.
  });
  process.on("uncaughtException", (err) => {
    try {
      alert(db, {
        source: "app", kind: "uncaught_exception", severity: "critical",
        group_key: "app:uncaught_exception",
        title: "Uncaught exception",
        message: err?.stack || String(err),
      });
    } catch (_) {}
    console.error("[uncaughtException]", err);
    // Continuing after an uncaught exception is unsafe; Cloud Run restarts
    // the instance. 2s lets the alert insert / critical-path send flush.
    setTimeout(() => process.exit(1), 2000);
  });
}

fs.readdirSync(routesPath).forEach((file) => {
  if (file.endsWith(".js")) {
    const route = require(`./routes/${file}`);
    app.use(route);
  }
});

// Error middleware — must mount AFTER all route mounts so next(err) from
// any route/middleware lands here. See lib/errorMiddleware.js for the
// coverage limitation note (most routes self-handle 500s and never reach it).
app.use(require("./lib/errorMiddleware")(db));

require("./startup/init")(db);
console.log("db ready");


// function listRoutes(app) {
//   function walk(stack, prefix = '') {
//     stack.forEach(layer => {
//       if (layer.route) {
//         const methods = Object.keys(layer.route.methods)
//           .map(m => m.toUpperCase())
//           .join(', ');
//         console.log(`${methods.padEnd(10)} ${prefix}${layer.route.path}`);
//       } 
//       else if (layer.name === 'router' && layer.handle.stack) {
//         walk(layer.handle.stack, prefix);
//       }
//     });
//   }
//   walk(app._router.stack);
// }
// if (process.env.ENVIRONMENT == "development") {
//   listRoutes(app);
// }

// Set port and start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('Node runtime:', process.version);
  console.log(`Server is running on port ${PORT}.`);
  if (process.env.ENVIRONMENT == "development") {
    console.log(`visit http://localhost:${PORT}/`);
  }
});