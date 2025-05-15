const express = require("express");
const cors = require("cors");
const mysql = require("mysql");
const fetch = require("node-fetch");
const path = require('path');
const fs = require("fs");

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



const db = mysql.createPool({
  connectionLimit: 10,
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database
});

// Handle MySQL connection errors
db.on("error", (err) => {
  console.error("Error connecting to MySQL database: " + err.stack);
});



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





//this is a temporary endpoint to fix a specific pabbly cors issue
app.get('/proxy-pabbly', async (req, res) => {
    try {
        const pabblyUrl = 'https://connect.pabbly.com/workflow/sendwebhookdata/IjU3NjUwNTZhMDYzNTA0MzU1MjY1NTUzNjUxMzUi_pc?'
            + new URLSearchParams(req.query).toString(); // Pass query params dynamically

        const response = await fetch(pabblyUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        // Check if response is JSON
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
            const data = await response.json();
            res.json(data);
        } else {
            const text = await response.text();
            res.send(text);
        }

    } catch (error) {
        console.error("Error fetching Pabbly response:", error);
        res.status(500).json({ error: "Failed to fetch data from Pabbly", details: error.message });
    }
});


require("./startup/init")(db);


// Set port and start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
});
