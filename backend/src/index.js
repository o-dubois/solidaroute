/**
 * @file index.js
 * @description SolidaRoute API — Express application entry point.
 *
 * Bootstraps the Express application in the following order:
 *   1. Security middleware — helmet (HTTP headers), CORS, rate limiting
 *   2. Body parsers — JSON and URL-encoded form data
 *   3. Request logging — every inbound request is logged with method, path, and IP
 *   4. Route mounting — each feature area has its own router module
 *   5. Health check endpoint — used by PM2/load balancer to confirm the server is alive
 *   6. Global error handler — catches errors from all routes via next(err);
 *      includes special handling for PostgreSQL unique-constraint violations (code 23505)
 *      which distinguishes between phone and email conflicts and returns descriptive codes
 *   7. Startup sequence — verifies DB connectivity before accepting traffic
 *
 * Port: process.env.PORT (default 4000)
 *
 * Process manager: PM2 (ecosystem.config.js in project root)
 *   - PM2 sets NODE_ENV, JWT_SECRET, DB_*, SMTP_*, and FILE_ENCRYPTION_KEY
 *   - The app is exported at the bottom for use in automated tests (supertest)
 */

require('dotenv').config();
const { logger }         = require('./utils/logger');
const { testConnection } = require('./db/pool');
const app                = require('./app');

// ── Server startup ────────────────────────────────────────────
const PORT = process.env.PORT || 4000;

/**
 * Starts the HTTP server after confirming the database is reachable.
 * Calling testConnection() before listen() ensures the process exits
 * immediately with a clear error if the DB credentials are wrong or the
 * server is down — rather than starting and silently failing on the first request.
 */
async function start() {
  await testConnection(); // Throws on failure — caught by the .catch() below
  app.listen(PORT, () =>
    logger.info(`SolidaRoute API v5.0 running on port ${PORT}`)
  );
}

// If startup fails (DB unreachable, port in use, etc.), log and exit with code 1
// so PM2 treats it as a crash and can apply its restart policy.
start().catch(err => {
  logger.error('Failed to start server', { message: err.message });
  process.exit(1);
});

// Export the app for integration testing (e.g., supertest in Jest test suites)
module.exports = app;
