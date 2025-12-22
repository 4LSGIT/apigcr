// lib/unplacehold.js

const pad = (n) => (n < 10 ? "0" + n : n);

/* --- helpers copied exactly from your route --- */

const ORDINAL_WORDS = [
  "First","Second","Third","Fourth","Fifth","Sixth","Seventh","Eighth","Ninth","Tenth",
  "Eleventh","Twelfth","Thirteenth","Fourteenth","Fifteenth","Sixteenth","Seventeenth","Eighteenth","Nineteenth","Twentieth",
  "Twenty-first","Twenty-second","Twenty-third","Twenty-fourth","Twenty-fifth","Twenty-sixth","Twenty-seventh","Twenty-eighth","Twenty-ninth","Thirtieth",
  "Thirty-first"
];

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

const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const WEEKDAYS_ABBR = ["Sun","Mon","Tues","Wed","Thurs","Fri","Sat"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sept","Oct","Nov","Dec"];

const formatDate = (value, format) => {
  const d = new Date(value);
  if (isNaN(d)) return null;

  const tokens = {
    YYYY: d.getFullYear(),
    MM: pad(d.getMonth()+1),
    MMMM: MONTHS[d.getMonth()],
    MMM: MONTHS_ABBR[d.getMonth()],
    DD: pad(d.getDate()),
    D: d.getDate(),
    Do: ordinal(d.getDate()),
    DoW: ordinalWord(d.getDate()),
    dddd: WEEKDAYS[d.getDay()],
    ddd: WEEKDAYS_ABBR[d.getDay()],
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

/* --- main exported function --- */

module.exports = async function unplacehold({
  db,
  text,
  contact_id,
  case_id,
  case_number,
  case_number_full,
  appt_id,
  strict = false
}) {
  let contact = null;
  let caseData = null;
  let appt = null;

  const conn = await db.promise().getConnection();

  try {
    if (contact_id) {
      const [r] = await conn.query(
        "SELECT * FROM contacts WHERE contact_id=?",
        [contact_id]
      );
      if (r.length) contact = r[0];
    }

    if (case_id || case_number || case_number_full) {
      let q, p;
      if (case_id) { q="SELECT * FROM cases WHERE case_id=?"; p=case_id; }
      else if (case_number_full) { q="SELECT * FROM cases WHERE case_number_full=?"; p=case_number_full; }
      else { q="SELECT * FROM cases WHERE case_number=?"; p=case_number; }

      const [r] = await conn.query(q, [p]);
      if (r.length) caseData = r[0];
    }

    if (appt_id) {
      const [r] = await conn.query(
        "SELECT * FROM appts WHERE appt_id=?",
        [appt_id]
      );
      if (r.length) appt = r[0];
    }
  } finally {
    conn.release();
  }

  let output = text;
  const unresolved = [];

  const resolveEntity = (entityName, entity) => {
    const regex = /{{(\w+)\.(\w+)(?:\|([^}]+))?}}/g;

    output = output.replace(regex, (match, e, field, pipe) => {
      if (e !== entityName) return match;

      let value = entity?.[field];
      let format = null;
      let def = null;

      if (pipe) {
        pipe.split("|").forEach(part => {
          if (part.startsWith("date:") || part.startsWith("time:") || part.startsWith("datetime:")) {
            format = part.slice(part.indexOf(":") + 1);
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

  return { status, text: output, unresolved };
};
