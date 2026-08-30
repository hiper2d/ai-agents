// Unit suites run by default. Live suites (`*.live.test.ts`) hit real provider endpoints,
// cost money, and need API keys in .env — run them deliberately with `npm run test:live`
// (after agent changes, before SDK upgrades, before a release).
const LIVE_TEST_PATTERN = '\\.live\\.test\\.ts$';

module.exports = {
  preset: 'ts-jest',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }],
  },
  testEnvironment: 'node',
  setupFiles: ['dotenv/config'],
  roots: ['<rootDir>/src'],
  testTimeout: 60000,
  // The live pattern is read by jest.live.config.js (always index 1 here).
  testPathIgnorePatterns: ['/node_modules/', LIVE_TEST_PATTERN],
};
