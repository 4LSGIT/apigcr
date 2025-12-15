/*
  --- UNPLACEHOLD USAGE ---

  POST /unplacehold
  Headers: Content-Type: application/json
  Body:
  {
    "username": "admin",
    "password": "secret",
    "text": "Hello {{contact.contact_first_name}}, your appointment is on {{appt.appt_date|date:dddd, MMMM DoW|default:TBD}}.",
    "contact_id": 12,
    "case_id": 5,
    "appt_id": 88,
    "strict": false   // optional; true = fail if any placeholder unresolved
  }

  Placeholders:
    Contact: {{contact.first_name}}, {{contact.last_name}}, etc.
    Case: {{case.case_number}}, {{case.judge_name|default:Unassigned}}, etc.
    Appointment:
      {{appt.appt_date|date:dddd}}   → Tuesday
      {{appt.appt_date|date:ddd}}    → Tues
      {{appt.appt_date|date:MMMM}}   → July
      {{appt.appt_date|date:MMM}}    → Jul
      {{appt.appt_date|date:D}}      → 4
      {{appt.appt_date|date:DD}}     → 04
      {{appt.appt_date|date:Do}}     → 4th
      {{appt.appt_date|date:DoW}}    → Fourth
      {{appt.start_time|time:hh:mm A}} → 09:30 AM

  Pipe modifiers:
    |date:<format>       → format a date
    |time:<format>       → format a time
    |datetime:<format>   → format date+time
    |default:<value>     → fallback if missing or invalid

  Response:
  {
    "status": "success" | "partial_success" | "failed",
    "text": "Resolved text",
    "unresolved": ["{{case.judge_name}}"]
  }
*/
const express = require("express");
const router = express.Router();

/* ------------------ helpers ------------------ */

const getClientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() ||
  req.socket?.remoteAddress;

// zero-pad helper
const pad = (n) => (n < 10 ? "0" + n : n);

// numeric to word mapping for ordinals
const ORDINAL_WORDS = [
  "First","Second","Third","Fourth","Fifth","Sixth","Seventh","Eighth","Ninth","Tenth",
  "Eleventh","Twelfth","Thirteenth","Fourteenth","Fifteenth","Sixteenth","Seventeenth","Eighteenth","Nineteenth","Twentieth",
  "Twenty-first","Twenty-second","Twenty-third","Twenty-fourth","Twenty-fifth","Twenty-sixth","Twenty-seventh","Twenty-eighth","Twenty-ninth","Thirtieth",
  "Thirty-first"
];

// ordinal helpers
const ordinal = (n) => {
  if (n % 100 >= 11 && n % 100 <= 13) return n + "th";
  switch (n % 10) {
    case 1: return n + "st";
    case 2: return n + "nd";
    case 3: return n + "rd";
    default: return n + "th";
  }
};
const ordinalWord = (n) => ORDINAL_WORDS[n-1] || n;

// day/month names (safe, explicit)
const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const WEEKDAYS_ABBR = ["Sun","Mon","Tues","Wed","Thurs","Fri","Sat"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sept","Oct","Nov","Dec"];

// SAFE date/time formatter (no external libs)
const formatDate = (value, format) => {
  const d = new Date(value);
  if (isNaN(d)) return null;

  const tokens = {
    // year
    YYYY: d.getFullYear(),

    // month
    MM: pad(d.getMonth()+1),
    MMMM: MONTHS[d.getMonth()],
    MMM: MONTHS_ABBR[d.getMonth()],

    // day of month
    DD: pad(d.getDate()),
    D: d.getDate(),
    Do: ordinal(d.getDate()),
    DoW: ordinalWord(d.getDate()),

    // weekday
    dddd: WEEKDAYS[d.getDay()],
    ddd: WEEKDAYS_ABBR[d.getDay()],

    // time
    HH: pad(d.getHours()),
    hh: pad(d.getHours()%12||12),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    A: d.getHours()>=12?"PM":"AM",
  };

  let output = format;
  Object.keys(tokens).sort((a,b)=>b.length-a.length).forEach(t=>{
    output = output.replaceAll(t,tokens[t]);
  });

  return output;
};



const logAttempt = (db, username, password, ip, userAgent, status) => {
  const q = `
    INSERT INTO query_log
    (username, password, ip_address, user_agent, query, auth_status)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  db.getConnection((err, c) => {
    if (err) return;
    c.query(q, [username, password, ip, userAgent, "unplacehold", status], () =>
      c.release()
    );
  });
};

/* ------------------ route ------------------ */

router.post("/unplacehold", (req, res) => {
  const {
    username,
    password,
    text,
    strict = false,

    contact_id,

    case_id,
    case_number,
    case_number_full,

    appt_id,
  } = req.body;

  if (!username || !password || !text) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  const ip = getClientIp(req);
  const userAgent = req.headers["user-agent"] || "unknown";

  const authQuery =
    "SELECT user_auth FROM users WHERE username = ? AND password = ?";

  req.db.getConnection((err, conn) => {
    if (err) return res.status(500).json({ error: "DB connection error" });

    conn.query(authQuery, [username, password], (err, auth) => {
      if (err || !auth.length || !auth[0].user_auth.startsWith("authorized")) {
        conn.release();
        logAttempt(req.db, username, password, ip, userAgent, "unauthorized");
        return res.status(401).json({ error: "Unauthorized" });
      }

      logAttempt(req.db, username, password, ip, userAgent, "authorized");

      let contact = null;
      let caseData = null;
      let appt = null;
      const tasks = [];

      if (contact_id) {
        tasks.push(
          new Promise((resolve) => {
            conn.query(
              "SELECT * FROM contacts WHERE contact_id = ?",
              [contact_id],
              (_, r) => {
                if (r?.length) contact = r[0];
                resolve();
              }
            );
          })
        );
      }

      if (case_id || case_number || case_number_full) {
        let q, p;
        if (case_id) {
          q = "SELECT * FROM cases WHERE case_id = ?";
          p = case_id;
        } else if (case_number_full) {
          q = "SELECT * FROM cases WHERE case_number_full = ?";
          p = case_number_full;
        } else {
          q = "SELECT * FROM cases WHERE case_number = ?";
          p = case_number;
        }

        tasks.push(
          new Promise((resolve) => {
            conn.query(q, [p], (_, r) => {
              if (r?.length) caseData = r[0];
              resolve();
            });
          })
        );
      }

      if (appt_id) {
        tasks.push(
          new Promise((resolve) => {
            conn.query(
              "SELECT * FROM appts WHERE appt_id = ?",
              [appt_id],
              (_, r) => {
                if (r?.length) appt = r[0];
                resolve();
              }
            );
          })
        );
      }

      Promise.all(tasks).then(() => {
        conn.release();

        const unresolved = [];
        let output = text;

        const resolveEntity = (entityName, entity) => {
          const regex =
            /{{(\w+)\.(\w+)(?:\|([^}]+))?}}/g;

          output = output.replace(regex, (match, e, field, pipe) => {
            if (e !== entityName) return match;

            let value = entity?.[field];

            let format = null;
            let def = null;

            if (pipe) {
              pipe.split("|").forEach((part) => {
                if (part.startsWith("date:") || part.startsWith("time:") || part.startsWith("datetime:")) {
                  format = part.split(":")[1];
                } else if (part.startsWith("default:")) {
                  def = part.slice(8);
                }
              });
            }

            if (value === undefined || value === null) {
              if (def !== null) return def;
              unresolved.push(match);
              return match;
            }

            if (format) {
              const formatted = formatDate(value, format);
              if (formatted === null) {
                if (def !== null) return def;
                unresolved.push(match);
                return match;
              }
              return formatted;
            }

            return value;
          });
        };

        resolveEntity("contact", contact);
        resolveEntity("case", caseData);
        resolveEntity("appt", appt);

        let status = "success";
        if (unresolved.length && strict) status = "failed";
        else if (unresolved.length) status = "partial_success";

        if (status === "failed") {
          return res.status(400).json({
            status,
            error: "Strict mode unresolved placeholders",
            unresolved,
          });
        }

        return res.json({
          status,
          text: output,
          unresolved,
        });
      });
    });
  });
});

module.exports = router;
