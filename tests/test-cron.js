const { CronExpressionParser } = require('cron-parser');

try {
const interval = CronExpressionParser.parse('*/5 * * * *');  // ← this works
  const next = interval.next().toDate();
  console.log('Next time:', next);
} catch (err) {
  console.error('Cron parse error:', err.message);
}