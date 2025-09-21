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

    // --- Fetch Hebcal holidays (only if not inside Shabbos detection; we still fetch around the window) ---
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
        events = [];
      }
    }

    // --- Build restricted days set (dates that are considered "non-workday" days) ---
    // We scan from day before input to +3 days (covers chains up to a few days)
    const restricted = new Set();
    const scanStart = inputDate.clone().subtract(1, 'day').startOf('day');
    const scanEnd = inputDate.clone().add(3, 'days').endOf('day');

    for (let d = scanStart.clone(); d.isSameOrBefore(scanEnd); d.add(1, 'day')) {
      const dateStr = d.format('YYYY-MM-DD');

      // Mark Saturday as restricted (Shabbos full date)
      if (d.day() === 6) {
        restricted.add(dateStr);
        continue;
      }

      // Check hebcal events for Yom Tov days (exclude 'Erev' entries)
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

    // --- Determine whether this specific input datetime is inside a holiday window (isHoliday) ---
    let isHoliday = false;
    let holidayName = null;
    if (!isShabbos) {
      for (const event of events) {
        if (event.category === 'holiday' && !event.title.startsWith('Erev')) {
          const isYomTov = YOM_TOV_HOLIDAYS.some(holiday =>
            holiday === 'Rosh Hashana' ? event.title.includes('Rosh Hashana') : event.title === holiday
          );
          if (!isYomTov) continue;

          // Define the holiday coverage window (same logic as shabbos: START_HOUR of previous day -> END_HOUR of event day)
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

    // --- Calculate workdayIn (minutes until next workday begins) ---
    // Behavior:
    // - If it's a workday => workdayIn = 0
    // - If not a workday => find the restricted *period* that covers the input datetime,
    //   extend through consecutive restricted days, take END_HOUR of last restricted day as reopen time,
    //   return minutes from input to that reopen time (0 if input is already past reopen time).
    let workdayIn = 0;

    if (!workday) {
      // 1) Find the restricted day whose coverage period contains inputDate
      let coveringDay = null;
      for (let d = scanStart.clone(); d.isSameOrBefore(scanEnd); d.add(1, 'day')) {
        const dateStr = d.format('YYYY-MM-DD');
        if (!restricted.has(dateStr)) continue;

        const periodStart = d.clone().subtract(1, 'day').set({ hour: START_HOUR, minute: 0, second: 0, millisecond: 0 });
        const periodEnd = d.clone().set({ hour: END_HOUR, minute: 0, second: 0, millisecond: 0 });

        if (inputDate.isSameOrAfter(periodStart) && inputDate.isBefore(periodEnd)) {
          // keep the latest covering day (if multiple overlap, the later one is the one that matters)
          coveringDay = d.clone();
        }
      }

      if (coveringDay) {
        // 2) Extend through consecutive restricted days to find the last restricted day in the chain
        let lastRestricted = coveringDay.clone();
        while (restricted.has(lastRestricted.clone().add(1, 'day').format('YYYY-MM-DD'))) {
          lastRestricted.add(1, 'day');
        }

        // 3) Reopen time is END_HOUR on lastRestricted
        const reopenTime = lastRestricted.clone().set({ hour: END_HOUR, minute: 0, second: 0, millisecond: 0 });

        if (inputDate.isSameOrAfter(reopenTime)) {
          workdayIn = 0;
        } else {
          workdayIn = reopenTime.diff(inputDate, 'minutes');
          if (workdayIn < 0) workdayIn = 0;
        }
      } else {
        // Fallback: if for some reason we couldn't find a covering restricted day
        // then find the next non-restricted day and use its END_HOUR as reopen time.
        let nextDay = inputDate.clone().startOf('day');
        let found = false;
        for (let i = 0; i < 7; i++) {
          const dateStr = nextDay.format('YYYY-MM-DD');
          if (!restricted.has(dateStr)) {
            const reopenTime = nextDay.clone().set({ hour: END_HOUR, minute: 0, second: 0, millisecond: 0 });
            if (inputDate.isSameOrAfter(reopenTime)) {
              workdayIn = 0;
            } else {
              workdayIn = reopenTime.diff(inputDate, 'minutes');
            }
            found = true;
            break;
          }
          nextDay.add(1, 'day');
        }
        if (!found) {
          // last-resort safety: set to 0
          workdayIn = 0;
        }
      }
    } else {
      // If it's a workday we follow your earlier instruction to return 0
      workdayIn = 0;
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
      version: '3' // bumped version for debugging
    };

    console.log(`Response: ${JSON.stringify(result)}`);
    return res.json(result);

  } catch (error) {
    console.error('Error in /isWorkday:', error && error.message ? error.message : error);
    return res.status(500).json({ error: 'Internal server error', details: error && error.message ? error.message : String(error) });
  }
});

module.exports = router;
