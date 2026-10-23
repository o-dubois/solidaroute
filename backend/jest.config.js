/**
 * Jest configuration for SolidaRoute backend integration tests.
 *
 * Key decisions:
 *   setupFiles     — loads .env.test into process.env BEFORE any module is
 *                    required by a test file. This ensures pool.js connects to
 *                    solidaroute_test, not the production database.
 *
 *   globalSetup    — runs once in a separate process before all test suites.
 *                    Truncates transactional tables and re-seeds the superadmin.
 *
 *   testTimeout    — 15 s per test. Most DB queries are fast but the first
 *                    connection and any TRUNCATE can take a moment.
 *
 *   testEnvironment — 'node' (no browser DOM needed for API tests).
 */
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['./tests/setup/env.js'],
  globalSetup:    './tests/setup/globalSetup.js',
  testMatch:      ['**/tests/**/*.test.js'],
  testTimeout:    15000,
  verbose:        true,
};
