const express = require("express");
const cors = require("cors");
const mysql = require("mysql");
const fetch = require("node-fetch");
const path = require('path');

const app = express();

var corsOptions = {
 // origin: "http://localhost:8081"
origin: "*"
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));


// MySQL Connection Configuration
const db = mysql.createPool({
  connectionLimit: 10, // Maximum number of connections in the pool
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database
});

// Handle MySQL connection errors
db.on("error", (err) => {
  console.error("Error connecting to MySQL database: " + err.stack);
});

app.get('/', (req, res) => {
  res.send('Where does the 4LSG API lives?');
});

// Route to handle user authentication and query processing
// Route to handle user authentication and query processing
app.get("/db", (req, res) => {
  const { username, password, query } = req.query;
 let queries = query.endsWith('|||') ? query.slice(0, -3) : query;
  queries = queries.split("|||");

  // Query to check user authorization
  const authQuery = "SELECT user_auth FROM users WHERE username = ? AND password = ?";
  const authParams = [username, password];

  db.getConnection((err, connection) => {
    if (err) {
      console.error("Error getting MySQL connection: " + err.stack);
      res.status(500).json({ error: "Error getting MySQL connection" });
      return;
    }

    connection.query(authQuery, authParams, (err, result) => {
      connection.release(); // Release the connection back to the pool

      if (err) {
        console.log(err);
        res.status(500).json({ error: "Error executing authorization query" });
      } else {
        if (result.length > 0 && result[0].user_auth.startsWith("authorized")) {
          // User is authorized, proceed with the main query
          db.getConnection((err, connection) => {
            if (err) {
              console.error("Error getting MySQL connection: " + err.stack);
              res.status(500).json({ error: "Error getting MySQL connection" });
              return;
            }

            let queryResults = {}; // Object to store the results of all queries

            // Execute each query in the order provided
            queries.forEach((query, index) => {
              if (query.trim() !== "") {
                connection.query(query, (err, result) => {
                  if (err) {
                    queryResults[`query${index + 1}`] = { error: err.message }; // Store the error message
                  } else {
                    queryResults[`query${index + 1}`] = result; // Store the query result
                  }

                  // Check if all queries have been executed
                  if (Object.keys(queryResults).length === queries.length) {
                    res.json({ data: queryResults }); // Return the results object
                  }
                });
              } else {
                queryResults[`query${index + 1}`] = { error: "Empty query" }; // Store the empty query error
              }
            });

            connection.release(); // Release the connection back to the pool
          });
        } else {
          res.status(401).json({ error: "Unauthorized access" });
        }
      }
    });
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

function parseName(name) {
  const suffixes = [ "jr", "sr", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
  const parts = name.replace(/,/g,"").split(" ");
  let firstName = parts[0] || "";
  let middleName = "";
  let lastName = "";
  let suffix = "";
  let lnameOnly = "";

  if (parts.length > 1) {
    if ( suffixes.includes( parts[parts.length - 1].toLowerCase().replace(".", "")) && parts.length > 2) {
      lastName = parts[parts.length - 2] + " " + parts[parts.length - 1];
      middleName = parts.slice(1, parts.length - 2).join(" ");
     lnameOnly = parts[parts.length-2].split("-")[0]
      suffix = parts[parts.length-1]
    } else {
      lastName = parts[parts.length - 1];
      middleName = parts.slice(1, parts.length - 1).join(" ");
     lnameOnly = lastName.split("-")[0]
    }
  }

  return [firstName, middleName, lastName, lnameOnly, suffix];
}

app.get("/parseName", (req, res) => {
  const { name } = req.query;
  const parsedName = parseName(name);
  res.json({ firstName: parsedName[0], middleName: parsedName[1], lastName: parsedName[2], lastNameOnly: parsedName[3], lastNameSuffix: parsedName[4]});
});




// Set port and start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
});
