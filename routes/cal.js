const express = require('express');
const fetch = require('node-fetch');
const moment = require('moment');
const router = express.Router();

// Configuration for holiday and Shabbos time ranges
const START_HOUR = 18; // 6 PM
const END_HOUR = 22;   // 10 PM

// List of strict Yom Tov holidays (based on provided list)
const YOM_TOV_HOLIDAYS = [
  'Rosh Hashana', // Will use partial match for variations like "Rosh Hashanah 5788" or "Rosh Hashanah II"
  'Yom Kippur',
  'Sukkot I',
  'Sukkot II',
  'Shmini Atzeret',
  'Simchat Torah',
  'Pesach I',
  'Pesach II',
  'Pesach VII',
  'Pesach VIII',
  'Shavuot I',
  'Shavuot II'
];

// Endpoint: /isWorkday?date=YYYY-MM-DDTHH:mm:ss
router.get('/isWorkday', async (req, res) => {
  try {
    const { date } = req.query;

    // Validate date parameter
    if (!date || !moment(date, moment.ISO_8601, true).isValid()) {
      return res.status(400).json({ error: 'Invalid or missing date parameter. Use format YYYY-MM-DDTHH:mm:ss' });
    }

    const inputDate = moment(date);
    const startDate = moment(inputDate).subtract(1, 'day').startOf('day'); // Start from previous day
    const endDate = moment(inputDate).add(1, 'day').endOf('day'); // End on the next day

    // Check if the input date falls within Shabbos (Friday 6 PM to Saturday 10 PM)
    let isShabbos = false;
    if (inputDate.day() === 5) { // Friday
      const shabbosStart = moment(inputDate).set({ hour: START_HOUR, minute: 0 });
      if (inputDate.isSameOrAfter(shabbosStart)) {
        isShabbos = true;
      }
    } else if (inputDate.day() === 6) { // Saturday
      const shabbosEnd = moment(inputDate).set({ hour: END_HOUR, minute: 0 });
      if (inputDate.isSameOrBefore(shabbosEnd)) {
        isShabbos = true;
      }
    }

    let isHoliday = false;
    let holidayName = null;

    // If not Shabbos, check for holidays
    if (!isShabbos) {
      // Fetch Jewish holidays from Hebcal API for the date range
      const hebcalUrl = `https://www.hebcal.com/hebcal?cfg=json&v=1&maj=on&min=on&mod=on&start=${startDate.format('YYYY-MM-DD')}&end=${endDate.format('YYYY-MM-DD')}`;
      const response = await fetch(hebcalUrl);
      if (!response.ok) {
        throw new Error(`Hebcal API request failed with status ${response.status}`);
      }
      const data = await response.json();
      const events = data.items;

      // Check if the date falls within a Yom Tov holiday period (6 PM previous day to 10 PM holiday)
      for (const event of events) {
        if (event.category === 'holiday' && !event.title.startsWith("Erev")) {
          // Check if the event title matches a Yom Tov holiday
          const isYomTov = YOM_TOV_HOLIDAYS.some(holiday => 
            holiday === 'Rosh Hashanah' ? event.title.includes('Rosh Hashanah') : event.title === holiday
          );
          if (isYomTov) {
            const holidayStart = moment(event.date).subtract(1, 'day').set({ hour: START_HOUR, minute: 0 }); // 6 PM previous day
            const holidayEnd = moment(event.date).set({ hour: END_HOUR, minute: 0 }); // 10 PM holiday
            if (inputDate.isBetween(holidayStart, holidayEnd, null, '[]')) {
              isHoliday = true;
              holidayName = event.title;
              break;
            }
          }
        }
      }
    }

    // Prepare response
    const result = {
      date: inputDate.format('YYYY-MM-DDTHH:mm:ss'),
      isShabbos,
      isHoliday,
      holidayName: isHoliday ? holidayName : null,
      workday: !isShabbos && !isHoliday
    };

    res.json(result);
  } catch (error) {
    console.error('Error checking holiday:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
