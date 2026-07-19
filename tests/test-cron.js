// tests/test-cron.js
//
// Ad-hoc script: confirms the cron-parser v5 named-export API
// (CronExpressionParser.parse) works — not a formal jest suite. The test- /
// test_ prefix is this repo's convention for "not a jest file".
//
// Run:
//   node tests/test-cron.js

const { CronExpressionParser } = require('cron-parser');

try {
const interval = CronExpressionParser.parse('*/5 * * * *');  // ← this works
  const next = interval.next().toDate();
  console.log('Next time:', next);
} catch (err) {
  console.error('Cron parse error:', err.message);
}