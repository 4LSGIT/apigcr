const express = require("express");
const router = express.Router();
const path = require("path");

router.get('/delay', (req, res) => {
  const { value, delay, callback} = req.query
    // Do something
    console.log('Received GET request at /');
    let v = parseInt(value, 10) + 1;
    res.json({message: "success", value:v})
    setTimeout(() => {
        fetch(`${callback}?message=delayed&value=${delay} ms`);
    }, delay); 
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


router.get('/date', (req, res) => {
  res.send({"date":dateNow()})
});




router.get('/myip', async (req, res) => {
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

router.get("/parseName", (req, res) => {
  const { name } = req.query;
  const parsedName = parseName(name);
  res.json({ firstName: parsedName[0], middleName: parsedName[1], lastName: parsedName[2], lastNameOnly: parsedName[3], lastNameSuffix: parsedName[4], flname: parsedName[5]});
});



module.exports = router;