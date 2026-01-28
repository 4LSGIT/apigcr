const E = (id) => document.getElementById(id);
const V = (id) => document.getElementById(id).value;
const S = (id) => document.getElementById(id).style;
const D = (id) => document.getElementById(id).style.display;
const U = (str) =>
  encodeURIComponent(
    str.replace(/(["'`\\])/g, "\\\\$1").replace(/\n/g, "\\\\n")
  );
const X = (str) => str.replace(/(["'`\\])/g, "\\$1").replace(/\n/g, "\\n");

function resizeTextarea(textarea) {
  textarea.style.height = "auto"; // Reset height
  textarea.style.height = Math.min(textarea.scrollHeight, 300) + "px"; // Adjust but don't exceed max
}

// Function to compare dates in EST with DST consideration
function whenDate(date) {
  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  date = new Date(date);
  if (now < date) {
    return "future";
  } else {
    return "past";
  }
}

window.Toast = Swal.mixin({
  toast: true,
  position: "top",
  showConfirmButton: true,
  timer: 3000,
  timerProgressBar: true,
  didOpen: (toast) => {
    toast.onmouseenter = Swal.stopTimer;
    toast.onmouseleave = Swal.resumeTimer;
  },
});

function copy(text) {
  navigator.clipboard.writeText(text);
  Toast.fire({ icon: "success", title: `"${text}" copied to clipboard!` });
}

function showProcessingSwal() {
  Swal.fire({
    title: "Processing...",
    html: '<div style="display: flex; align-items: center; justify-content: center; height: 150px; overflow: hidden; display: block"><i class="fa-solid fa-spinner fa-spin-pulse fa-6x"></i><br><p><div>please wait</p>',
    showConfirmButton: false,
    width: "250px",
  });
}

let jwt
async function sendQuery(q) {
  try {
    let token = localStorage.getItem("jwt");
    // --- Decide whether to use JWT or legacy ---
    let url = "/db-jwt"; // new endpoint
    let headers = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    } else {
      // fallback to old credentials for now
      headers["Authorization"] = "Basic " + btoa(`${username}:${password}`);
      // OR you could keep the legacy query URL format if needed
      // url = `/db?username=${username}&password=${password}&query=...`
    }
    const response = await fetch(url + `?query=${encodeURIComponent(q)}`, {
      method: "GET",
      headers,
    });
    if (!response.ok) {
      throw new Error("Network response was not ok.");
    }
    const data = await response.json();
    // --- Refresh token handling ---
    if (data.token) {
      // JWT middleware returns refreshed token in the body
      localStorage.setItem("jwt", data.token);
      jwt = data.token; // optional: update local variable
    }
    console.log(data); // Handle the response data as needed
    return data;
  } catch (error) {
    console.error("Error in sendQueryNew:", error);
  }
}


async function apiSend(endpoint, method = "GET", payload = null) {
  const token = localStorage.getItem("jwt");
  let url = endpoint;
  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  };
  if (method === "GET" && payload) {
    const params = new URLSearchParams(payload).toString();
    url += "?" + params;
  } else if (payload) {
    options.body = JSON.stringify(payload);
  }
  const res = await fetch(url, options);
  const data = await res.json();
  // sliding refresh token support
  if (data.token) {
    localStorage.setItem("jwt", data.token);
  }
  if (!res.ok) {
    throw new Error(data.error || "API error");
  }
  return data;
}
/*
async function apiSend(endpoint, method = "GET", payload = null) {
  try {
    const token = localStorage.getItem("jwt_token");
    const options = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
    };
    if (token) {
      options.headers["Authorization"] = `Bearer ${token}`;
    }
    if (payload) {
      if (method.toUpperCase() === "GET") {
        // Attach payload as query params
        const queryParams = new URLSearchParams(payload).toString();
        endpoint += `?${queryParams}`;
      } else {
        options.body = JSON.stringify(payload);
      }
    }
    const response = await fetch(endpoint, options);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    // Handle refreshed token
    if (data.token) {
      localStorage.setItem("jwt_token", data.token);
    }
    return data;
  } catch (err) {
    console.error(`Error in apiSend(${endpoint}):`, err);
    throw err;
  }
}
*/

function dateParts(dateString) {
  return dateString && !dateString.startsWith("0000-00-00")
    ? dateString.split("T")[0].split("-")
    : ["", "", ""];
}

function dateTimeParts(dateString) {
  dateString =
    dateString && !dateString.startsWith("0000-00-00")
      ? [
          ...dateString.split("T")[0].split("-"),
          ...dateString.split("T")[1].split(":").slice(0, 2),
        ]
      : ["", "", "", "", "", "", ""];
  dateString[5] = dateString[3] >= 12 ? "PM" : "AM";
  dateString[3] = dateString[3] > 12 ? dateString[3] - 12 : dateString[3];
  return dateString;
}

function sort(header, sort) {
  const parentDiv = header.parentNode.parentNode.parentNode.parentNode;
  const sortBy = parentDiv.querySelector('select[data-type="sortBy"]');
  const sortDi = parentDiv.querySelector('select[data-type="sortDi"]');
  const go = parentDiv.querySelector('button[data-type="goButton"]');
  const headers = parentDiv.querySelectorAll("th");
  sort = sort || header.innerText.replace(" ↑", "").replace(" ↓", "");
  if (sortBy.value !== sort) {
    sortBy.value = sort;
  } else {
    sortDi.value = sortDi.value === "ASC" ? "DESC" : "ASC";
  }
  headers.forEach(
    (h) => (h.innerText = h.innerText.replace(" ↑", "").replace(" ↓", ""))
  );
  header.innerText += sortDi.value === "ASC" ? " ↑" : " ↓";
  go.click();
}

function sortSelect(element) {
  const sortBy = element.parentNode.querySelector('select[data-type="sortBy"]');
  const sortDi = element.parentNode.querySelector('select[data-type="sortDi"]');
  const go = element.parentNode.querySelector('button[data-type="goButton"]');
  const table = element.parentNode.parentNode.querySelector("table");
  const headers = table.querySelectorAll("th");
  headers.forEach((head) => {
    let header = "";
    if (head.onclick) {
      header = head.getAttribute("onclick").split("'")[1];
    }
    let text = head.innerText.replace(" ↑", "").replace(" ↓", "");
    if (sortBy.value === header) {
      head.innerText = `${text} ${sortDi.value === "ASC" ? " ↑" : " ↓"}`;
    } else {
      head.innerText = text;
    }
  });
  go.click();
}
