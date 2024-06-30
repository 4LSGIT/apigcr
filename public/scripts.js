const E = (id) => document.getElementById(id);
const V = (id) => document.getElementById(id).value;
const S = (id) => document.getElementById(id).style;
const D = (id) => document.getElementById(id).style.display;
const U = (str) => encodeURIComponent(str.replace(/(["'`\\])/g, '\\\\$1').replace(/\n/g, '\\\\n'))
// Function to compare dates in EST with DST consideration
function whenDate(date) {
  const now = new Date(new Date().toLocaleString("en-US", {timeZone: "America/New_York"}));
  date = new Date(date);
  if (now < date) { return "future"; } else { return "past"; }
}

const Toast = Swal.mixin({
  toast: true,
  position: "top",
  showConfirmButton: true,
  timer: 3000,
  timerProgressBar: true,
  didOpen: (toast) => {
    toast.onmouseenter = Swal.stopTimer;
    toast.onmouseleave = Swal.resumeTimer;
  }
}); 

  function copy(text){
    navigator.clipboard.writeText(text);
    Toast.fire({ icon: 'success', title: `"${text}" copied to clipboard!`});
  }

function showProcessingSwal() {
    Swal.fire({
        title: 'Processing...',
        html: '<div style="display: flex; align-items: center; justify-content: center; height: 150px; overflow: hidden; display: block"><i class="fa-solid fa-spinner fa-spin-pulse fa-6x"></i><br><p><div>please wait</p>',
        showConfirmButton: false,
        width: "250px"
    });
}




async function sendQuery(q) {
  try {
    const response = await fetch(`https://svpcac-ztvzsuxura-ue.a.run.app/db?username=${username}&password=${password}&query=${encodeURIComponent(q)}`);
    
    if (!response.ok) {
      throw new Error('Network response was not ok.');
    }
    
    const data = await response.json();
    console.log(data); // Handle the response data as needed
    return data;
  } catch (error) {
    console.error('Error:', error);
  }
}



 function dateParts(dateString) {
   return (dateString && !dateString.startsWith('0000-00-00')) ? dateString.split('T')[0].split('-'):["","",""]
 }

function dateTimeParts(dateString) {
  dateString =  (dateString && !dateString.startsWith('0000-00-00')) ? [...dateString.split("T")[0].split("-"), ...dateString.split("T")[1].split(":").slice(0, 2)] : ["", "", "", "", "", "", ""]
  dateString[5] = dateString[3] >= 12 ? "PM":"PM"
  dateString[3] = dateString[3] > 12 ? dateString[3]-12:dateString[3]
  return dateString
}
