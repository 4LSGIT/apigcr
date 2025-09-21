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

    // Wider date range for fetching holidays to handle chains
    const startDate = moment(inputDate).subtract(3, 'days').startOf('day');
    const endDate = moment(inputDate).add(5, 'days').endOf('day');

    // Fetch Jewish holidays from Hebcal API for the date range
    const hebcalUrl = `https://www.hebcal.com/hebcal?cfg=json&v=1&maj=on&min=on&mod=on&start=${startDate.format('YYYY-MM-DD')}&end=${endDate.format('YYYY-MM-DD')}`;
    const response = await fetch(hebcalUrl);
    if (!response.ok) {
      throw new Error(`Hebcal API request failed with status ${response.status}`);
    }
    const data = await response.json();
    const events = data.items;

    // Build restricted days (Saturdays or Yom Tov holidays)
    const restricted = new Set();
    for (let d = startDate.clone(); d.isBefore(endDate.add(1, 'day')); d.add(1, 'days')) {
      const dateStr = d.format('YYYY-MM-DD');
      let isRest = d.day() === 6;
      if (!isRest) {
        for (const event of events) {
          if (event.date.startsWith(dateStr) && event.category === 'holiday' && !event.title.startsWith("Erev")) {
            const isYomTov = YOM_TOV_HOLIDAYS.some(holiday => 
              holiday === 'Rosh Hashana' ? event.title.includes('Rosh Hashana') : event.title === holiday
            );
            if (isYomTov) {
              isRest = true;
              break;
            }
          }
        }
      }
      if (isRest) {
        restricted.add(dateStr);
      }
    }

    // Check if the input date falls within Shabbos (Friday 6 PM to Saturday 10 PM, exclusive end)
    let isShabbos = false;
    if (inputDate.day() === 5) { // Friday
      const shabbosStart = moment(inputDate).set({ hour: START_HOUR, minute: 0, second: 0 });
      if (inputDate.isSameOrAfter(shabbosStart)) {
        isShabbos = true;
      }
    } else if (inputDate.day() === 6) { // Saturday
      const shabbosEnd = moment(inputDate).set({ hour: END_HOUR, minute: 0, second: 0 });
      if (inputDate.isBefore(shabbosEnd)) {
        isShabbos = true;
      }
    }

    let isHoliday = false;
    let holidayName = null;

    // If not Shabbos, check for holidays
    if (!isShabbos) {
      // Check if the date falls within a Yom Tov holiday period (6 PM previous day to 10 PM holiday, exclusive end)
      for (const event of events) {
        if (event.category === 'holiday' && !event.title.startsWith("Erev")) {
          const isYomTov = YOM_TOV_HOLIDAYS.some(holiday => 
            holiday === 'Rosh Hashana' ? event.title.includes('Rosh Hashana') : event.title === holiday
          );
          if (isYomTov) {
            const holidayStart = moment(event.date).subtract(1, 'day').set({ hour: START_HOUR, minute: 0, second: 0 });
            const holidayEnd = moment(event.date).set({ hour: END_HOUR, minute: 0, second: 0 });
            if (inputDate.isSameOrAfter(holidayStart) && inputDate.isBefore(holidayEnd)) {
              isHoliday = true;
              holidayName = event.title;
              break;
            }
          }
        }
      }
    }

    const workday = !isShabbos && !isHoliday;

    // Calculate workdayIn
    let workdayIn = 0;
    if (!workday) {
      // Find covering restricted days (D where period covers inputDate)
      const coveringDs = [];
      for (const dateStr of restricted) {
        const D = moment(dateStr);
        const periodStart = D.clone().subtract(1, 'day').set({ hour: START_HOUR, minute: 0, second: 0 });
        const periodEnd = D.clone().set({ hour: END_HOUR, minute: 0, second: 0 });
        if (inputDate.isSameOrAfter(periodStart) && inputDate.isBefore(periodEnd)) {
          coveringDs.push(D);
        }
      }

      if (coveringDs.length === 0) {
        // Should not happen if !workday
        throw new Error('Inconsistent workday calculation');
      }

      // Find max D among covering
      let maxD = coveringDs.reduce((max, cur) => cur.isAfter(max) ? cur : max, coveringDs[0]);

      // Extend forward if consecutive restricted days
      let nextDay = maxD.clone().add(1, 'day').startOf('day');
      let nextDateStr = nextDay.format('YYYY-MM-DD');
      while (restricted.has(nextDateStr)) {
        maxD = nextDay.clone();
        nextDay.add(1, 'day');
        nextDateStr = nextDay.format('YYYY-MM-DD');
      }

      // End time is maxD at END_HOUR
      const endTime = maxD.clone().set({ hour: END_HOUR, minute: 0, second: 0 });

      // Minutes until endTime
      workdayIn = endTime.diff(inputDate, 'minutes');
    }

    // Prepare response
    const result = {
      date: inputDate.format('YYYY-MM-DDTHH:mm:ss'),
      isShabbos,
      isHoliday,
      holidayName: isHoliday ? holidayName : null,
      workday,
      workdayIn
    };

    res.json(result);
  } catch (error) {
    console.error('Error checking holiday:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
