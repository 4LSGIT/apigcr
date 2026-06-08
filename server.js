// server.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();
const { alert } = require("./lib/alerting");

const app = express();
var corsOptions = { origin: "*" };
app.use(cors(corsOptions));
app.set('trust proxy', 1);//google cloud run
// Capture raw body for webhook HMAC verification
app.use('/hooks', express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));
app.use(express.json({ limit: '10mb' }));//maybe limit to /upload?
app.use(express.urlencoded({ extended: true }));
// Landing pages: vanity-host middleware must run BEFORE express.static so a
// mapped domain's root doesn't fall into public/index.html.
const db = require("./startup/db");
app.use(require("./routes/pageLanding").pageHostMiddleware(db));
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, path, stat) => {
      if (path.endsWith(".js")) {
        res.set("Content-Type", "application/javascript");
      } else if (path.endsWith(".css")) {
        res.set("Content-Type", "text/css");
      }
    },
  })
);

//const db = require("./startup/db");//and we are going to attach it to each route


const routesPath = path.join(__dirname, "routes");

app.get("/:page", (req, res, next) => {
  const filePath = path.join(__dirname, "public", req.params.page + ".html");
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
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
  console.log(`Server is running on port ${PORT}.`);
  if (process.env.ENVIRONMENT == "development") {
    console.log(`visit http://localhost:${PORT}/`);
  }
});