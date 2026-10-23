/**
 * Jest setupFile — loaded before any module is imported in each test worker.
 *
 * By calling dotenv.config() here (pointing to .env.test), we ensure that
 * process.env.DB_NAME is 'solidaroute_test' when pool.js is first required.
 * Without this, pool.js would read the production .env and connect to the
 * live database.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env.test') });
