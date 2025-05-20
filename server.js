const express = require("express");
const cors = require("cors");
const mysql = require("mysql");
const fetch = require("node-fetch");
const path = require('path');
const fs = require("fs");
require('dotenv').config();

const app = express();
var corsOptions = { origin: "*"};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, path, stat) => {
    if (path.endsWith('.js')) {
      res.set('Content-Type', 'application/javascript');
    } else if (path.endsWith('.css')) {
      res.set('Content-Type', 'text/css');
    }
  }
}));


/*
//this was moved to /startup/db.js but left here for now for reference
const db = mysql.createPool({
  connectionLimit: 10,
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database
});
db.on("error", (err) => {
  console.error("Error connecting to MySQL database: " + err.stack);
});
*/
const db = require("./startup/db");


const routesPath = path.join(__dirname, "routes");
fs.readdirSync(routesPath).forEach((file) => {
  if (file.endsWith(".js")) {
    const route = require(`./routes/${file}`);
    app.use((req, res, next) => {
      req.db = db; // Attach db to request object
      next();
    }, route);
  }
});








require("./startup/init")(db);


// Set port and start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
});
