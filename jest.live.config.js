// Runs ONLY the live API suites that the default config excludes.
// Usage: npm run test:live  (requires provider keys in .env and network access)
const base = require('./jest.config');

const LIVE_TEST_PATTERN = base.testPathIgnorePatterns[1];

module.exports = {
  ...base,
  testPathIgnorePatterns: ['/node_modules/'],
  testRegex: LIVE_TEST_PATTERN,
  testTimeout: 240000,
};
