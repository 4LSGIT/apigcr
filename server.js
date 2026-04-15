const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
var corsOptions = { origin: "*" };
app.use(cors(corsOptions));
app.set('trust proxy', 1);//google cloud run
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
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

const db = require("./startup/db");//and we are going to attach it to each route


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

fs.readdirSync(routesPath).forEach((file) => {
  if (file.endsWith(".js")) {
    const route = require(`./routes/${file}`);
    app.use(route);
  }
});

require("./startup/init")(db);
console.log("db ready");

/*
function listRoutes(app) {
  function walk(stack, prefix = '') {
    stack.forEach(layer => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods)
          .map(m => m.toUpperCase())
          .join(', ');
        console.log(`${methods.padEnd(10)} ${prefix}${layer.route.path}`);
      } 
      else if (layer.name === 'router' && layer.handle.stack) {
        walk(layer.handle.stack, prefix);
      }
    });
  }
  walk(app._router.stack);
}
if (process.env.ENVIRONMENT == "development") {
  listRoutes(app);
}*/

// Set port and start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
  if (process.env.ENVIRONMENT == "development") {
    console.log(`visit http://localhost:${PORT}/`);
  }
});
