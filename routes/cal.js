const express = require('express');
const fetch = require('node-fetch');
const moment = require('moment');
const router = express.Router();

// Endpoint: /isHoliday?date=YYYY-MM-DDTHH:mm:ss
router.get('/isHoliday', async (req, res) => {
  try {
    const { date } = req.query;

    // Validate date parameter
    if (!date || !moment(date, moment.ISO_8601, true).isValid()) {
      return res.status(400).json({ error: 'Invalid or missing date parameter. Use format YYYY-MM-DDTHH:mm:ss' });
    }

    const inputDate = moment(date);
    const startDate = moment(inputDate).subtract(1, 'day').startOf('day'); // Start from previous day
    const endDate = moment(inputDate).endOf('day'); // End on the given day

    // Check if the input date is a Saturday (Shabbat)
    const isSaturday = inputDate.day() === 6;
    let isHoliday = false;
    let holidayName = null;

    // If within time range, check for holidays
    if (!isSaturday) {
      // Fetch Jewish holidays from Hebcal API for the date range
      const hebcalUrl = `https://www.hebcal.com/hebcal?cfg=json&v=1&maj=on&min=on&mod=on&start=${startDate.format('YYYY-MM-DD')}&end=${endDate.format('YYYY-MM-DD')}`;
      const response = await fetch(hebcalUrl);
      if (!response.ok) {
        throw new Error(`Hebcal API request failed with status ${response.status}`);
      }
      const data = await response.json();
      const events = data.items;

      // Check if the date falls within a holiday period (6 PM previous day to 10 PM holiday)
      for (const event of events) {
        if (event.category === 'holiday') {
          const holidayStart = moment(event.date).subtract(6, 'hours'); // 6 PM previous day
          const holidayEnd = moment(event.date)/*.add(0, 'day')*/.set({ hour: 22, minute: 0 }); // 10 PM holiday
          if (inputDate.isBetween(holidayStart, holidayEnd, null, '[]') && !event.title.startsWith("Erev")) {
            isHoliday = true;
            holidayName = event.title;
            break;
          }
        }
      }
    }

    // Prepare response
    const result = {
      date: inputDate.format('YYYY-MM-DDTHH:mm:ss'),
      isShabbat: isSaturday,
      isHoliday,
      holidayName: isHoliday ? holidayName : null,
    };

    res.json(result);
  } catch (error) {
    console.error('Error checking holiday:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;