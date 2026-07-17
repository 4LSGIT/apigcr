// jest.config.js
//
// Minimal on purpose. setupFiles centralizes fail-fast env seeding
// (tests/jest.setup.js) so test files don't each hand-roll it and
// `npm test` works from a clean shell with no exports.
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/jest.setup.js'],
};