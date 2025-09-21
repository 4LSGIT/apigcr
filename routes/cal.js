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

// Endpoint: /isWorkday?date=YYYY-MM-DDTHH:mm:ss  OR  YYYY-MM-DD HH:mm:ss
router.get('/isWorkday', async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({
        error: 'Missing date parameter. Use format YYYY-MM-DDTHH:mm:ss or YYYY-MM-DD HH:mm:ss'
      });
    }

    // Normalize: replace space with "T" so both formats work
    const normalizedDate = date.replace(' ', 'T');
    const inputDate = moment(normalizedDate, moment.ISO_8601, true);

    if (!inputDate.isValid()) {
      return res.status(400).json({
        error: 'Invalid date parameter. Use format YYYY-MM-DDTHH:mm:ss or YYYY-MM-DD HH:mm:ss'
      });
    }

    console.log(`Processing date: ${inputDate.format('YYYY-MM-DDTHH:mm:ss')}`);

    // --- Check Shabbos (Friday after START_HOUR -> Saturday before END_HOUR) ---
    let isShabbos = false;
    if (inputDate.day() === 5) { // Friday
      const shabbosStart = inputDate.clone().set({ hour: START_HOUR, minute: 0, second: 0, millisecond: 0 });
      if (inputDate.isSameOrAfter(shabbosStart)) isShabbos = true;
    } else if (inputDate.day() === 6) { // Saturday
      const shabbosEnd = inputDate.clone().set({ hour: END_HOUR, minute: 0, second: 0, millisecond: 0 });
      if (inputDate.isBefore(shabbosEnd)) isShabbos = true;
    }
    console.log(`Is Shabbos: ${isShabbos}`);

    // --- Fetch Hebcal holidays (scan around input date) ---
    let events = [];
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
      events = [];
    }

    // --- Build restricted days set (Shabbos + Yom Tov days) ---
    const restricted = new Set();
    for (let d = startDate.clone(); d.isSameOrBefore(endDate); d.add(1, 'day')) {
      const dateStr = d.format('YYYY-MM-DD');
      if (d.day() === 6) {
        restricted.add(dateStr);
        continue;
      }
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
    console.log(`Restricted days: ${Array.from(restricted).join(', ')}`);

    // --- Holiday check (specific window detection) ---
    let isHoliday = false;
    let holidayName = null;
    if (!isShabbos) {
      for (const event of events) {
        if (event.category === 'holiday' && !event.title.startsWith('Erev')) {
          const isYomTov = YOM_TOV_HOLIDAYS.some(holiday =>
            holiday === 'Rosh Hashana' ? event.title.includes('Rosh Hashana') : event.title === holiday
          );
          if (!isYomTov) continue;
          const holidayStart = moment(event.date).subtract(1, 'day').set({ hour: START_HOUR, minute: 0, second: 0, millisecond: 0 });
          const holidayEnd = moment(event.date).set({ hour: END_HOUR, minute: 0, second: 0, millisecond: 0 });
          if (inputDate.isSameOrAfter(holidayStart) && inputDate.isBefore(holidayEnd)) {
            isHoliday = true;
            holidayName = event.title;
            break;
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
      let coveringDay = null;
      for (let d = startDate.clone(); d.isSameOrBefore(endDate); d.add(1, 'day')) {
        const dateStr = d.format('YYYY-MM-DD');
        if (!restricted.has(dateStr)) continue;
        const periodStart = d.clone().subtract(1, 'day').set({ hour: START_HOUR, minute: 0, second: 0, millisecond: 0 });
        const periodEnd = d.clone().set({ hour: END_HOUR, minute: 0, second: 0, millisecond: 0 });
        if (inputDate.isSameOrAfter(periodStart) && inputDate.isBefore(periodEnd)) {
          coveringDay = d.clone();
        }
      }
      if (coveringDay) {
        let lastRestricted = coveringDay.clone();
        while (restricted.has(lastRestricted.clone().add(1, 'day').format('YYYY-MM-DD'))) {
          lastRestricted.add(1, 'day');
        }
        const reopenTime = lastRestricted.clone().set({ hour: END_HOUR, minute: 0, second: 0, millisecond: 0 });
        workdayIn = inputDate.isSameOrAfter(reopenTime) ? 0 : reopenTime.diff(inputDate, 'minutes');
      }
    }

    // --- Response ---
    const result = {
      date: inputDate.format('YYYY-MM-DDTHH:mm:ss'),
      isShabbos,
      isHoliday,
      holidayName: isHoliday ? holidayName : null,
      workday,
      workdayIn,
      version: '5'
    };

    console.log(`Response: ${JSON.stringify(result)}`);
    return res.json(result);

  } catch (error) {
    console.error('Error in /isWorkday:', error.message);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

module.exports = router;
