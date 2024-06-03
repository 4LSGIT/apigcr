const express = require("express");
const cors = require("cors");
const mysql = require("mysql");
const fetch = require("node-fetch");

const app = express();

var corsOptions = {
  origin: "http://localhost:8081"
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MySQL Connection Configuration
const db = mysql.createConnection({
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database
});

db.connect((err) => {
  if (err) {
    console.error("Error connecting to MySQL database: " + err.stack);
    return;
  }
  console.log("Connected to MySQL database as ID " + db.threadId);
});


app.get('/', (req, res) => {
  res.send('Welcome');
});

// Route to handle user authentication and query processing
app.get("/db", (req, res) => {
  const { username, password, query } = req.query;
console.log(req)
  // Query to check user authorization
  const authQuery = `SELECT user_auth FROM users WHERE username='${username}' AND password='${password}'`;
  console.log(authQuery)

  db.query(authQuery, (err, result) => {
    if (err) {
      console.log("error is: "+err)
      res.status(500).json({ error: "Error executing authorization query" });
    } else {
      console.log(result)
      if (result.length > 0 && result[0].user_auth.startsWith("authorized")) {
        // User is authorized, proceed with the main query
        db.query(query, (err, result) => {
          if (err) {
            res.status(500).json({ error: "Error executing main query" });
          } else {
            res.json({ data: result });
          }
        });
      } else {
        res.status(401).json({ error: "Unauthorized access" });
      }
    }
  });
});


app.get('/delay', (req, res) => {
  const { value, delay, callback} = req.query
    // Do something
    console.log('Received GET request at /');
    let v = parseInt(value, 10) + 1;
    //res.send('Webhook received successfully');
    res.json({message: "success", value:v})
    setTimeout(() => {
        fetch(`${callback}?message=delayed&value=${delay} ms`);
    }, delay); 
});



app.get('/myip', async (req, res) => {
    try {
        const response = await fetch('https://curlmyip.org');
        const data = await response.text();
        const ipAddress = data.trim(); // Extract IP address from the response

        res.json({ ip: ipAddress });
    } catch (error) {
        console.error('Error fetching IP address:', error);
        res.status(500).json({ error: 'Failed to fetch IP address' });
    }
});



// Set port and start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
});
