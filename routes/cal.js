const express = require('express');
const fetch = require('node-fetch');
const moment = require('moment');
const router = express.Router();

// Configuration for holiday and Shabbos time ranges
const START_HOUR = 18; // 6 PM
const END_HOUR = 22;   // 10 PM

// List of strict Yom Tov holidays
const YOM_TOV_HOLIDAYS = [
  'Rosh Hashana',
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
      console.log('Invalid date parameter received:', date);
      return res.status(400).json({ error: 'Invalid or missing date parameter. Use format YYYY-MM-DDTHH:mm:ss' });
    }

    const inputDate = moment(date);
    console.log(`Processing date: ${inputDate.format('YYYY-MM-DDTHH:mm:ss')}`);

    // --- Check Shabbos ---
    let isShabbos = false;
    if (inputDate.day() === 5) { // Friday
      const shabbosStart = inputDate.clone().set({ hour: START_HOUR, minute: 0, second: 0 });
      if (inputDate.isSameOrAfter(shabbosStart)) isShabbos = true;
    } else if (inputDate.day() === 6) { // Saturday
      const shabbosEnd = inputDate.clone().set({ hour: END_HOUR, minute: 0, second: 0 });
      if (inputDate.isBefore(shabbosEnd)) isShabbos = true;
    }
    console.log(`Is Shabbos: ${isShabbos}`);

    // --- Fetch Hebcal holidays if not Shabbos ---
    let events = [];
    if (!isShabbos) {
      const startDate = inputDate.clone().subtract(1, 'day').startOf('day');
      const endDate = inputDate.clone().add(3, 'days').endOf('day');
      const hebcalUrl = `https://www.hebcal.com/hebcal?cfg=json&v=1&maj=on&min=on&mod=on&start=${startDate.format('YYYY-MM-DD')}&end=${endDate.format('YYYY-MM-DD')}`;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(hebcalUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          events = data.items || [];
          console.log(`Hebcal events received: ${events.length}`);
        } else {
          console.error(`Hebcal API failed: ${response.status}`);
        }
      } catch (apiError) {
        console.error('Hebcal API error:', apiError.message);
      }
    }

    // --- Build restricted days ---
    const restricted = new Set();
    const startScan = inputDate.clone().subtract(1, 'day').startOf('day');
    const endScan = inputDate.clone().add(3, 'days').endOf('day');

    for (let d = startScan.clone(); d.isSameOrBefore(endScan); d.add(1, 'day')) {
      const dateStr = d.format('YYYY-MM-DD');
      if (d.day() === 6) {
        restricted.add(dateStr);
      } else {
        for (const event of events) {
          if (event.date.startsWith(dateStr) && event.category === 'holiday' && !event.title.startsWith('Erev')) {
            const isYomTov = YOM_TOV_HOLIDAYS.some(holiday =>
              holiday === 'Rosh Hashana' ? event.title.includes('Rosh Hashana') : event.title === holiday
            );
            if (isYomTov) {
              restricted.add(dateStr);
              break;
            }
          }
        }
      }
    }
    console.log(`Restricted days: ${Array.from(restricted).join(', ')}`);

    // --- Check if input date is inside holiday window ---
    let isHoliday = false;
    let holidayName = null;
    if (!isShabbos) {
      for (const event of events) {
        if (event.category === 'holiday' && !event.title.startsWith('Erev')) {
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
    console.log(`Is Holiday: ${isHoliday}, Holiday Name: ${holidayName}`);

    const workday = !isShabbos && !isHoliday;
    console.log(`Is Workday: ${workday}`);

    // --- Calculate workdayIn ---
    let workdayIn = 0;
    if (!workday) {
      let currentDay = inputDate.clone().startOf('day');

      // Skip forward through restricted days
      while (restricted.has(currentDay.format('YYYY-MM-DD'))) {
        currentDay.add(1, 'day');
      }

      // The next non-restricted day's END_HOUR is when work resumes
      const nextWorkdayEnd = currentDay.clone().set({ hour: END_HOUR, minute: 0, second: 0 });

      if (inputDate.isBefore(nextWorkdayEnd)) {
        workdayIn = nextWorkdayEnd.diff(inputDate, 'minutes');
      } else {
        workdayIn = 0; // Already past END_HOUR
      }
    }
    console.log(`Workday In: ${workdayIn} minutes`);

    // --- Response ---
    const result = {
      date: inputDate.format('YYYY-MM-DDTHH:mm:ss'),
      isShabbos,
      isHoliday,
      holidayName: isHoliday ? holidayName : null,
      workday,
      workdayIn,
      version: "2"
    };

    console.log(`Response: ${JSON.stringify(result)}`);
    res.json(result);

  } catch (error) {
    console.error('Error in /isWorkday:', error.message);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

module.exports = router;
