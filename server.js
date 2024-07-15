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

app.get('/', (req, res) => {
  res.send('Where does the 4LSG API lives?');
});
app.get('/appt', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'appt.html'));
});

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

function dateNow(){
const now = new Date();
const estOffset = -4; // EST offset from UTC
const dstOffset = isDST(now.getFullYear(), now.getMonth(), now.getDate()) ? 1 : 0; // Check if DST is in effect

const estWithDST = new Date(now.getTime() + (estOffset + dstOffset) * 3600000);
const mysqlFormattedDateTime = estWithDST.toISOString().slice(0, 19).replace('T', ' ');
return mysqlFormattedDateTime

function isDST(year, month, day) {
  const dstStart = getNthWeekdayOfMonth(year, 2, 0, 1); // DST starts on the second Sunday in March
  const dstEnd = getNthWeekdayOfMonth(year, 10, 0, 1); // DST ends on the first Sunday in November
  const checkDate = new Date(year, month, day);

  return checkDate >= dstStart && checkDate < dstEnd && checkDate.getDay() === 0;
}
function getNthWeekdayOfMonth(year, month, weekday, n) {
  const date = new Date(year, month, 1);
  let count = 0;
  while (date.getDay() !== weekday || count < n) {
    if (date.getDay() === weekday) {
      count++;
    }
    date.setDate(date.getDate() + 1);
  }
  return date;
}
}

app.get('/date', (req, res) => {
res.send({"date":dateNow()})
});



app.post("/logEmail", (req, res) => {
  let { to, from, subject, body_plain, attachments} = req.body;
  if (from.endsWith("@4lsg.com") && to.endsWith("@4lsg.com")) {
    res.status(200).json({ message: "Internal Email not logged" });
    return;
  }
  const currentDate = dateNow();
  const contactEmail = from.toLowerCase().endsWith("@4lsg.com") ? to : from;
  subject = subject.replace(/["']/g, '\\$&');
  let message = body_plain.replace(/["']/g, '\\$&');
  if (attachments && Array.isArray(attachments) && attachments.length > 0) {
    attachments.forEach((attachment, index) => {
      message += `\nAttachment ${index + 1}: ${attachment}`;
    });
  }
  let string = `{"From": "${from}", "To": "${to}", "Subject": "${subject}", "Message": "${message}"}`;
  if (string.length > 65501){
    string = string.substring(0,65500) + '"}'
  }
  const insertQuery = `INSERT INTO log (log_type, log_date, log_link, log_by, log_data) SELECT "email", "${currentDate}", c.contact_id, 0, '${string}' FROM contacts c WHERE c.contact_email = "${contactEmail}"`;
  db.query(insertQuery, (err, result) => {
  if (err) {
    console.error("Error inserting email data into the log table:", err);
    res.status(500).json({ error: "Failed to log email data", details: err.message , sql: insertQuery});
  } else {
    res.status(200).json({ message: "Email data logged successfully", details: result, sql: insertQuery});
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

function parseName(name) {
  const suffixes = [ "jr", "sr", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
  const parts = name.replace(/,/g,"").replace(/\\n/g," ").replace(/\n/g, ' ').replace(/  /g, ' ').split(" ");
  let firstName = parts[0] || "";
  let middleName = "";
  let lastName = "";
  let suffix = "";
  let lnameOnly = "";
  let flname = "";

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
  flname = firstName + (lnameOnly?` ${lnameOnly}`:"");

  return [firstName, middleName, lastName, lnameOnly, suffix, flname];
}

app.get("/parseName", (req, res) => {
  const { name } = req.query;
  const parsedName = parseName(name);
  res.json({ firstName: parsedName[0], middleName: parsedName[1], lastName: parsedName[2], lastNameOnly: parsedName[3], lastNameSuffix: parsedName[4], flname: parsedName[5]});
});




// Set port and start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
});
